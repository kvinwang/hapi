import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { ModelMode, PermissionMode } from '@/types/api'
import type { AgentType } from '@/components/NewSession/types'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionResponse, mergeSessionsResponse } from '@/lib/session-cache'
import { clearMessageWindow } from '@/lib/message-window-store'
import { isKnownFlavor } from '@/lib/agentFlavorUtils'

export type SwitchAgentOptions = {
    targetAgent: AgentType
    /** Start the incoming agent with a blank transcript instead of resuming its own. */
    resetContext?: boolean
    injectCatchUpPrompt?: boolean
}

export function useSessionActions(
    api: ApiClient | null,
    sessionId: string | null,
    agentFlavor?: string | null
): {
    abortSession: () => Promise<void>
    interruptSession: () => Promise<void>
    resumeSession: () => Promise<string>
    forkSession: (messageSeq: number) => Promise<string>
    convertSession: (targetAgent: 'claude' | 'codex') => Promise<string>
    switchSessionAgent: (options: SwitchAgentOptions) => Promise<{ sessionId: string; resumedTranscript: boolean }>
    archiveSession: () => Promise<void>
    switchSession: () => Promise<void>
    setPermissionMode: (mode: PermissionMode) => Promise<void>
    setModelMode: (mode: ModelMode) => Promise<void>
    setEffortMode: (mode: string) => Promise<void>
    renameSession: (name: string) => Promise<void>
    reparentSession: (parentSessionId: string | null) => Promise<void>
    deleteSession: (mode?: 'single' | 'detach-children' | 'recursive') => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()

    const invalidateSession = async () => {
        if (!sessionId) return
        await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const abortMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.abortSession(sessionId)
        },
        onMutate: () => {
            if (!sessionId) return
            const patch = { thinking: false }
            queryClient.setQueryData(queryKeys.session(sessionId), (current: unknown) =>
                mergeSessionResponse(current as Parameters<typeof mergeSessionResponse>[0], patch)
            )
            queryClient.setQueryData(queryKeys.sessions, (current: unknown) =>
                mergeSessionsResponse(current as Parameters<typeof mergeSessionsResponse>[0], sessionId, patch)
            )
        },
        onSuccess: () => void invalidateSession(),
    })

    const interruptMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.interruptSession(sessionId)
        },
    })

    const archiveMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.archiveSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const resumeMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.resumeSession(sessionId)
        },
        onSuccess: async (resolvedSessionId) => {
            if (!sessionId) return
            await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
            if (resolvedSessionId !== sessionId) {
                await queryClient.invalidateQueries({ queryKey: queryKeys.session(resolvedSessionId) })
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    const forkMutation = useMutation({
        mutationFn: async (messageSeq: number) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.forkSession(sessionId, messageSeq)
        },
        onSuccess: async (newSessionId) => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            await queryClient.invalidateQueries({ queryKey: queryKeys.session(newSessionId) })
        },
    })

    const convertMutation = useMutation({
        mutationFn: async (targetAgent: 'claude' | 'codex') => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.convertSession(sessionId, targetAgent)
        },
        onSuccess: async (newSessionId) => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            await queryClient.invalidateQueries({ queryKey: queryKeys.session(newSessionId) })
        },
    })

    const switchAgentMutation = useMutation({
        mutationFn: async (options: SwitchAgentOptions) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.switchSessionAgent(sessionId, options)
        },
        onSuccess: async () => {
            // The incoming agent reports its own model, context window and modes, so everything the
            // chrome shows about the agent is stale until it does.
            clearMessageWindow(sessionId ?? '')
            await invalidateSession()
        },
    })

    const switchMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.switchSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const permissionMutation = useMutation({
        mutationFn: async (mode: PermissionMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            if (isKnownFlavor(agentFlavor) && !isPermissionModeAllowedForFlavor(mode, agentFlavor)) {
                throw new Error('Invalid permission mode for session flavor')
            }
            await api.setPermissionMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const modelMutation = useMutation({
        mutationFn: async (mode: ModelMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setModelMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const effortMutation = useMutation({
        mutationFn: async (mode: string) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setEffortMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const renameMutation = useMutation({
        mutationFn: async (name: string) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.renameSession(sessionId, name)
        },
        onSuccess: () => void invalidateSession(),
    })

    const reparentMutation = useMutation({
        mutationFn: async (parentSessionId: string | null) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.reparentSession(sessionId, parentSessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const deleteMutation = useMutation({
        mutationFn: async (mode: 'single' | 'detach-children' | 'recursive' = 'single') => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.deleteSession(sessionId, mode)
        },
        onSuccess: async () => {
            if (!sessionId) return
            queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) })
            clearMessageWindow(sessionId)
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    return {
        abortSession: abortMutation.mutateAsync,
        interruptSession: interruptMutation.mutateAsync,
        resumeSession: resumeMutation.mutateAsync,
        forkSession: forkMutation.mutateAsync,
        convertSession: convertMutation.mutateAsync,
        switchSessionAgent: switchAgentMutation.mutateAsync,
        archiveSession: archiveMutation.mutateAsync,
        switchSession: switchMutation.mutateAsync,
        setPermissionMode: permissionMutation.mutateAsync,
        setModelMode: modelMutation.mutateAsync,
        setEffortMode: effortMutation.mutateAsync,
        renameSession: renameMutation.mutateAsync,
        reparentSession: reparentMutation.mutateAsync,
        deleteSession: (mode) => deleteMutation.mutateAsync(mode ?? 'single'),
        isPending: abortMutation.isPending
            || interruptMutation.isPending
            || resumeMutation.isPending
            || forkMutation.isPending
            || convertMutation.isPending
            || switchAgentMutation.isPending
            || archiveMutation.isPending
            || switchMutation.isPending
            || permissionMutation.isPending
            || modelMutation.isPending
            || effortMutation.isPending
            || renameMutation.isPending
            || reparentMutation.isPending
            || deleteMutation.isPending,
    }
}
