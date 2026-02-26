import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Credential } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCredentials(api: ApiClient | null, enabled: boolean): {
    credentials: Credential[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.credentials,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getCredentials()
        },
        enabled: Boolean(api && enabled),
    })

    return {
        credentials: query.data?.credentials ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load credentials' : null,
        refetch: query.refetch,
    }
}
