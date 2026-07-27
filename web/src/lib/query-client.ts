import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 5_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
        mutations: {
            retry: 0,
        },
    },
})

/**
 * Which account the cache restored from disk belonged to, recorded during bootstrap.
 *
 * The snapshot is keyed by hub URL, which is all that is knowable before authentication. Once the
 * user is known, `App` compares the two and drops the cache if the account changed.
 */
let restoredCacheUserId: number | null = null

export function setRestoredCacheUserId(userId: number | null): void {
    restoredCacheUserId = userId
}

export function getRestoredCacheUserId(): number | null {
    return restoredCacheUserId
}
