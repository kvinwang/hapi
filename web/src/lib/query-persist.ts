import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query'

/**
 * Persist part of the react-query cache to IndexedDB so a PWA cold start can paint the sessions
 * list and session chrome before the network answers.
 *
 * Deliberately narrow: only the small, cheap-to-serialize queries that make up the app's chrome are
 * stored. Messages have their own store, and file/terminal payloads are large and go stale fast.
 */
const DB_NAME = 'hapi-query-cache'
const STORE_NAME = 'cache'
const RECORD_KEY = 'react-query'
const SCHEMA_VERSION = 1
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const WRITE_DEBOUNCE_MS = 2_000
const RESTORE_TIMEOUT_MS = 400

const PERSISTED_KEY_ROOTS = new Set(['sessions', 'session', 'machines', 'preferences'])

type PersistedRecord = {
    version: number
    savedAt: number
    baseUrl: string
    userId: number | null
    state: DehydratedState
}

function openDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(null)
    }
    return new Promise((resolve) => {
        let request: IDBOpenDBRequest
        try {
            request = indexedDB.open(DB_NAME, 1)
        } catch {
            resolve(null)
            return
        }
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME)
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
    })
}

async function readRecord(): Promise<PersistedRecord | null> {
    const db = await openDatabase()
    if (!db) {
        return null
    }
    try {
        return await new Promise<PersistedRecord | null>((resolve) => {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(RECORD_KEY)
            request.onsuccess = () => resolve((request.result as PersistedRecord | undefined) ?? null)
            request.onerror = () => resolve(null)
        })
    } finally {
        db.close()
    }
}

async function writeRecord(record: PersistedRecord): Promise<void> {
    const db = await openDatabase()
    if (!db) {
        return
    }
    try {
        await new Promise<void>((resolve) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite')
            transaction.objectStore(STORE_NAME).put(record, RECORD_KEY)
            transaction.oncomplete = () => resolve()
            // A quota or serialization failure just means no warm start next time.
            transaction.onerror = () => resolve()
            transaction.onabort = () => resolve()
        })
    } finally {
        db.close()
    }
}

export async function clearPersistedQueryCache(): Promise<void> {
    const db = await openDatabase()
    if (!db) {
        return
    }
    try {
        await new Promise<void>((resolve) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite')
            transaction.objectStore(STORE_NAME).delete(RECORD_KEY)
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => resolve()
            transaction.onabort = () => resolve()
        })
    } finally {
        db.close()
    }
}

/**
 * Hydrate the cache from disk. Returns the user id the snapshot belonged to, so the caller can drop
 * it once authentication reveals a different account.
 *
 * `hydrate` never overwrites an entry that is already fresher, so calling this concurrently with
 * in-flight queries is safe. It is still raced against a timeout: a warm start is an optimization,
 * and a wedged IndexedDB must not hold up first paint.
 */
export async function restoreQueryCache(
    queryClient: QueryClient,
    baseUrl: string
): Promise<{ restored: boolean; userId: number | null }> {
    const miss = { restored: false, userId: null }
    const record = await Promise.race([
        readRecord().catch(() => null),
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), RESTORE_TIMEOUT_MS) })
    ])

    if (!record || record.version !== SCHEMA_VERSION || record.baseUrl !== baseUrl) {
        return miss
    }
    if (Date.now() - record.savedAt > MAX_AGE_MS) {
        void clearPersistedQueryCache()
        return miss
    }

    try {
        hydrate(queryClient, record.state)
    } catch {
        void clearPersistedQueryCache()
        return miss
    }
    return { restored: true, userId: record.userId }
}

/** Mirror cache changes to IndexedDB. Returns an unsubscribe function. */
export function startQueryCachePersistence(
    queryClient: QueryClient,
    baseUrl: string,
    userId: number | null
): () => void {
    if (typeof indexedDB === 'undefined') {
        return () => {}
    }

    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    const flush = () => {
        timer = null
        if (disposed) {
            return
        }
        const state = dehydrate(queryClient, {
            shouldDehydrateQuery: (query) => (
                query.state.status === 'success'
                && typeof query.queryKey[0] === 'string'
                && PERSISTED_KEY_ROOTS.has(query.queryKey[0] as string)
            ),
            shouldDehydrateMutation: () => false
        })
        void writeRecord({ version: SCHEMA_VERSION, savedAt: Date.now(), baseUrl, userId, state })
    }

    const schedule = () => {
        if (disposed || timer !== null) {
            return
        }
        timer = setTimeout(flush, WRITE_DEBOUNCE_MS)
    }

    const unsubscribe = queryClient.getQueryCache().subscribe(schedule)
    schedule()

    return () => {
        disposed = true
        if (timer !== null) {
            clearTimeout(timer)
        }
        unsubscribe()
    }
}
