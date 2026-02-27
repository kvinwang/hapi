import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ApiKey, AccessToken } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useApiKeys(api: ApiClient | null, enabled: boolean): {
    apiKeys: ApiKey[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.apiKeys,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getApiKeys()
        },
        enabled: Boolean(api && enabled),
    })

    return {
        apiKeys: query.data?.apiKeys ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load API keys' : null,
        refetch: query.refetch,
    }
}

export function useAccessTokens(api: ApiClient | null, apiKeyId: string | null): {
    tokens: AccessToken[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.apiKeyTokens(apiKeyId ?? ''),
        queryFn: async () => {
            if (!api || !apiKeyId) throw new Error('API unavailable')
            return await api.getAccessTokens(apiKeyId)
        },
        enabled: Boolean(api && apiKeyId),
    })

    return {
        tokens: query.data?.tokens ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load tokens' : null,
        refetch: query.refetch,
    }
}
