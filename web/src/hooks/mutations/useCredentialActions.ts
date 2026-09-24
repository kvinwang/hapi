import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CredentialAgent, CredentialConfig } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { CredentialResponse, ApplyCredentialsResponse, DiscoverModelsResponse, ReadCredentialsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type SaveCredentialInput = {
    id?: string
    name: string
    config: CredentialConfig
}

type ApplyCredentialsInput = {
    machineId: string
    credentialId: string
    agent: CredentialAgent
}

function requireApi(api: ApiClient | null): ApiClient {
    if (!api) throw new Error('API unavailable')
    return api
}

export function useSaveCredential(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async ({ id, ...params }: SaveCredentialInput): Promise<CredentialResponse> =>
            id ? await requireApi(api).updateCredential(id, params) : await requireApi(api).createCredential(params),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.credentials })
        },
    })
}

export function useDeleteCredential(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (id: string): Promise<void> => await requireApi(api).deleteCredential(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.credentials })
        },
    })
}

export function useDiscoverCredentialModels(api: ApiClient | null) {
    return useMutation({
        mutationFn: async (input: Pick<CredentialConfig, 'apiKey' | 'endpoints' | 'headers'>): Promise<DiscoverModelsResponse> =>
            await requireApi(api).discoverCredentialModels(input),
    })
}

export function useApplyCredentials(api: ApiClient | null) {
    return useMutation({
        mutationFn: async ({ machineId, ...params }: ApplyCredentialsInput): Promise<ApplyCredentialsResponse> =>
            await requireApi(api).applyCredentials(machineId, params),
    })
}

export function useReadMachineCredentials(api: ApiClient | null) {
    return useMutation({
        mutationFn: async (input: { machineId: string; agent: CredentialAgent }): Promise<ReadCredentialsResponse> =>
            await requireApi(api).readMachineCredentials(input.machineId, input.agent),
    })
}
