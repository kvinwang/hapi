import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionsResponse } from '@/lib/session-cache'

export function useSessionFavorite(api: ApiClient | null, sessionId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (favorite: boolean) => {
            if (!api) throw new Error('Session unavailable')
            return api.updateSessionUiState(sessionId, { favorite })
        },
        onSuccess: async (state) => {
            queryClient.setQueryData(queryKeys.sessionUiState(sessionId), state)
            queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current =>
                mergeSessionsResponse(current, sessionId, { uiState: state })
            )
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        }
    })
}
