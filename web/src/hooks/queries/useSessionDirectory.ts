import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DirectoryEntry } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessionDirectory(
    api: ApiClient | null,
    sessionId: string | null,
    path: string,
    options?: { enabled?: boolean; cwd?: string }
): {
    entries: DirectoryEntry[]
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const cwd = options?.cwd
    const enabled = Boolean(api && sessionId) && (options?.enabled ?? true)

    const query = useQuery({
        queryKey: queryKeys.sessionDirectory(resolvedSessionId, path, cwd),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }

            const response = await api.listSessionDirectory(sessionId, path, cwd)
            if (!response.success) {
                return { entries: [], error: response.error ?? 'Failed to list directory' }
            }

            return { entries: response.entries ?? [], error: null }
        },
        enabled,
    })

    const queryError = query.error instanceof Error
        ? query.error.message
        : query.error
            ? 'Failed to list directory'
            : null

    return {
        entries: query.data?.entries ?? [],
        error: queryError ?? query.data?.error ?? null,
        isLoading: query.isLoading,
        refetch: query.refetch
    }
}
