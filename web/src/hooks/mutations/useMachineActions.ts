import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useUnbindMachine(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (machineId: string): Promise<{ ok: boolean }> => {
            if (!api) throw new Error('API unavailable')
            return await api.unbindMachine(machineId)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.managedMachines })
        },
    })
}

export function useDeleteMachine(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (machineId: string): Promise<{ ok: boolean }> => {
            if (!api) throw new Error('API unavailable')
            return await api.deleteMachine(machineId)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.managedMachines })
        },
    })
}

export function useUpdateMachineNotes(api: ApiClient | null) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async ({ machineId, notes }: { machineId: string; notes: string | null }): Promise<{ ok: boolean; notes: string | null }> => {
            if (!api) throw new Error('API unavailable')
            return await api.updateMachineNotes(machineId, notes)
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.managedMachines })
        },
    })
}
