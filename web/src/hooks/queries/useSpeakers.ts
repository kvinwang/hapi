import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Speaker } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSpeakers(api: ApiClient | null): {
    speakers: Speaker[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.speakers,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getSpeakers()
        },
        enabled: Boolean(api),
    })

    return {
        speakers: query.data?.speakers ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load speakers' : null,
        refetch: query.refetch,
    }
}
