import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { TreeEntry } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessionDirectory(
    api: ApiClient | null,
    sessionId: string,
    path: string,
    options?: { enabled?: boolean }
): { entries: TreeEntry[]; isLoading: boolean; error: string | null } {
    const query = useQuery({
        queryKey: queryKeys.sessionDirectory(sessionId, path),
        enabled: options?.enabled === true && Boolean(api),
        queryFn: async () => {
            if (!api) {
                throw new Error('Missing API client')
            }
            const res = await api.browseSessionTree(sessionId, path)
            if (!res.success) {
                throw new Error(res.error ?? 'Failed to load directory')
            }
            return res.entries ?? []
        }
    })

    return {
        entries: query.data ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? String(query.error) : null
    }
}

