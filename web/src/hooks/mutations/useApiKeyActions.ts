import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { ApiKeyPermission, AccessToken, CreateApiKeyResponse, CreateAccessTokenResponse, UpdateApiKeyResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type CreateApiKeyInput = {
    name: string
    namespace?: string
    permissions?: ApiKeyPermission[]
}

export function useCreateApiKey(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: CreateApiKeyInput): Promise<CreateApiKeyResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.createApiKey(input)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
        },
    })
}

export function useUpdateApiKey(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { id: string; name?: string; permissions?: ApiKeyPermission[] }): Promise<UpdateApiKeyResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.updateApiKey(input.id, { name: input.name, permissions: input.permissions })
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
        },
    })
}

export function useUpdateApiKeyPermissions(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { id: string; permissions: ApiKeyPermission[] }): Promise<UpdateApiKeyResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.updateApiKeyPermissions(input.id, input.permissions)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
        },
    })
}

export function useRevokeApiKey(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            if (!api) throw new Error('API unavailable')
            return await api.revokeApiKey(id)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
        },
    })
}

export function useRestoreApiKey(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            if (!api) throw new Error('API unavailable')
            return await api.restoreApiKey(id)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
        },
    })
}

type CreateAccessTokenInput = {
    apiKeyId: string
    name: string
    expiresIn: '1d' | '7d' | '30d' | 'never'
}

export function useCreateAccessToken(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: CreateAccessTokenInput): Promise<CreateAccessTokenResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.createAccessToken(input.apiKeyId, { name: input.name, expiresIn: input.expiresIn })
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeyTokens(variables.apiKeyId) })
        },
    })
}

export function useUpdateAccessToken(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { apiKeyId: string; tokenId: string; name?: string; expiresIn?: '1d' | '7d' | '30d' | 'never' }): Promise<{ token: AccessToken }> => {
            if (!api) throw new Error('API unavailable')
            return await api.updateAccessToken(input.apiKeyId, input.tokenId, { name: input.name, expiresIn: input.expiresIn })
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeyTokens(variables.apiKeyId) })
        },
    })
}

export function useRevokeAccessToken(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { apiKeyId: string; tokenId: string }): Promise<void> => {
            if (!api) throw new Error('API unavailable')
            return await api.revokeAccessToken(input.apiKeyId, input.tokenId)
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeyTokens(variables.apiKeyId) })
        },
    })
}

export function useRestoreAccessToken(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { apiKeyId: string; tokenId: string }): Promise<void> => {
            if (!api) throw new Error('API unavailable')
            return await api.restoreAccessToken(input.apiKeyId, input.tokenId)
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeyTokens(variables.apiKeyId) })
        },
    })
}
