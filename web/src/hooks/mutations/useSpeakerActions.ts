import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SpeakerResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useCreateSpeaker(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { id: string; name: string; sessionId?: string }): Promise<SpeakerResponse> => {
            if (!api) throw new Error('API unavailable')
            return await api.createSpeaker(input)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.speakers })
        },
    })
}

export function useUpdateSpeaker(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (input: { id: string; name?: string; sessionId?: string | null }): Promise<SpeakerResponse> => {
            if (!api) throw new Error('API unavailable')
            const { id, ...params } = input
            return await api.updateSpeaker(id, params)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.speakers })
        },
    })
}

export function useDeleteSpeaker(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            if (!api) throw new Error('API unavailable')
            await api.deleteSpeaker(id)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.speakers })
        },
    })
}
