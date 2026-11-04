import { useCallback, useMemo, useSyncExternalStore } from 'react'

export type ConversationKind = 'sessions' | 'threads'
export type ConversationLocation = { id: string; fromSession?: string }
type History = Partial<Record<ConversationKind, ConversationLocation>>
const EVENT = 'hapi-conversation-history'
const fallback = new Map<string, string>()
const validId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[/?#]/.test(value)

const storageKey = (baseUrl?: string) => `hapi.conversation-history:${baseUrl || window.location.origin}`

function read(key: string): string {
    try {
        return localStorage.getItem(key) ?? ''
    } catch {
        return fallback.get(key) ?? ''
    }
}
function parse(raw: string): History {
    try {
        const source = JSON.parse(raw) as Record<string, unknown>
        const result: History = {}
        for (const kind of ['sessions', 'threads'] as const) {
            const entry = source?.[kind]
            if (!entry || typeof entry !== 'object' || !('id' in entry) || !validId(entry.id) || entry.id === 'new')
                continue
            result[kind] = {
                id: entry.id,
                ...(kind === 'threads' && 'fromSession' in entry && validId(entry.fromSession)
                    ? { fromSession: entry.fromSession }
                    : {})
            }
        }
        return result
    } catch {
        return {}
    }
}
function subscribe(listener: () => void): () => void {
    window.addEventListener(EVENT, listener)
    window.addEventListener('storage', listener)
    return () => {
        window.removeEventListener(EVENT, listener)
        window.removeEventListener('storage', listener)
    }
}

export function forgetConversation(kind: ConversationKind, id: string, baseUrl?: string): void {
    const key = storageKey(baseUrl)
    const current = parse(read(key))
    if (current[kind]?.id !== id) return
    delete current[kind]
    const value = JSON.stringify(current)
    fallback.set(key, value)
    try {
        localStorage.setItem(key, value)
    } catch {
        /* Keep navigation memory for this page. */
    }
    window.dispatchEvent(new Event(EVENT))
}

/** Shared by both workspaces and their tabs; list/new routes never replace a remembered conversation. */
export function useConversationHistory(baseUrl?: string) {
    const key = storageKey(baseUrl)
    const raw = useSyncExternalStore(
        subscribe,
        () => read(key),
        () => ''
    )
    const history = useMemo(() => parse(raw), [raw])
    const remember = useCallback(
        (kind: ConversationKind, id: string, fromSession?: string) => {
            if (!validId(id) || id === 'new') return
            const current = parse(read(key))
            const next = { id, ...(kind === 'threads' && validId(fromSession) ? { fromSession } : {}) }
            if (JSON.stringify(current[kind]) === JSON.stringify(next)) return
            const value = JSON.stringify({ ...current, [kind]: next })
            fallback.set(key, value)
            try {
                localStorage.setItem(key, value)
            } catch {
                /* Keep navigation memory for this page. */
            }
            window.dispatchEvent(new Event(EVENT))
        },
        [key]
    )
    return { history, remember }
}
