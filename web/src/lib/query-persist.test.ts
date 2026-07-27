import { afterEach, describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import {
    clearPersistedQueryCache,
    restoreQueryCache,
    startQueryCachePersistence
} from '@/lib/query-persist'

const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')

function setIndexedDB(value: unknown): void {
    Object.defineProperty(globalThis, 'indexedDB', { value, configurable: true, writable: true })
}

afterEach(() => {
    if (originalIndexedDB) {
        Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB)
    } else {
        Reflect.deleteProperty(globalThis, 'indexedDB')
    }
})

// Safari private browsing and hardened browser profiles expose no IndexedDB at all. Persistence is
// an optimization, so every entry point has to degrade to a no-op instead of throwing during
// bootstrap — which would take the whole app down before first paint.
describe('without IndexedDB', () => {
    it('reports a cache miss instead of throwing', async () => {
        setIndexedDB(undefined)
        const queryClient = new QueryClient()

        await expect(restoreQueryCache(queryClient, 'https://hub.example')).resolves.toEqual({
            restored: false,
            userId: null
        })
    })

    it('returns a disposer that can be called safely', () => {
        setIndexedDB(undefined)
        const queryClient = new QueryClient()
        queryClient.setQueryData(queryKeys.sessions, { sessions: [] })

        const stop = startQueryCachePersistence(queryClient, 'https://hub.example', 7)
        expect(() => stop()).not.toThrow()
    })

    it('resolves when asked to clear', async () => {
        setIndexedDB(undefined)
        await expect(clearPersistedQueryCache()).resolves.toBeUndefined()
    })
})

describe('when IndexedDB fails to open', () => {
    it('treats an open error as a cache miss', async () => {
        setIndexedDB({
            open: () => {
                const request: Record<string, unknown> = { result: null }
                queueMicrotask(() => {
                    (request.onerror as (() => void) | undefined)?.()
                })
                return request
            }
        })
        const queryClient = new QueryClient()

        await expect(restoreQueryCache(queryClient, 'https://hub.example')).resolves.toEqual({
            restored: false,
            userId: null
        })
    })
})
