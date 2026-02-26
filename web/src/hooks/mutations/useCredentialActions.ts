import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CredentialResponse, ApplyCredentialsResponse, ReadCredentialsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type CreateCredentialInput = {
    name: string
    agentType: 'claude' | 'codex'
    config: unknown
}

type UpdateCredentialInput = {
    id: string
    name?: string
    config?: unknown
}

type ApplyCredentialsInput = {
    machineId: string
    credentialId: string
    agentType: 'claude' | 'codex'
}

export function useCreateCredential(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: CreateCredentialInput): Promise<CredentialResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.createCredential(input)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.credentials })
        },
    })
}

export function useUpdateCredential(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: UpdateCredentialInput): Promise<CredentialResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.updateCredential(input.id, {
                name: input.name,
                config: input.config
            })
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.credentials })
        },
    })
}

export function useDeleteCredential(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            if (!api) throw new Error('API unavailable')
            return await api.deleteCredential(id)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.credentials })
        },
    })
}

export function useApplyCredentials(api: ApiClient | null) {
    return useMutation({
        mutationFn: async (input: ApplyCredentialsInput): Promise<ApplyCredentialsResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.applyCredentials(input.machineId, {
                credentialId: input.credentialId,
                agentType: input.agentType
            })
        },
    })
}

export function useReadMachineCredentials(api: ApiClient | null) {
    return useMutation({
        mutationFn: async (input: { machineId: string; agentType: 'claude' | 'codex' }): Promise<ReadCredentialsResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.readMachineCredentials(input.machineId, input.agentType)
        },
    })
}
