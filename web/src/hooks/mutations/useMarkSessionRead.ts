import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionsResponse } from '@/lib/session-cache'

const MARK_DELAY_MS = 1000

/** Advance the session's read marker to the newest message on screen while the page is visible. */
export function useMarkSessionRead(api: ApiClient | null, sessionId: string, messages: DecryptedMessage[]): void {
    const queryClient = useQueryClient()
    const seq = messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0)
    useEffect(() => {
        if (!api || seq === 0) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const mark = () => {
            clearTimeout(timer)
            if (document.visibilityState !== 'visible') return
            const readSeq = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions.find(s => s.id === sessionId)?.readSeq
            if (readSeq !== undefined && readSeq >= seq) return
            timer = setTimeout(() => {
                void api.updateSessionUiState(sessionId, { readSeq: seq }).then(state => {
                    queryClient.setQueryData(queryKeys.sessionUiState(sessionId), state)
                    queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current =>
                        mergeSessionsResponse(current, sessionId, { uiState: state })
                    )
                }).catch(() => {})
            }, MARK_DELAY_MS)
        }
        mark()
        document.addEventListener('visibilitychange', mark)
        return () => {
            clearTimeout(timer)
            document.removeEventListener('visibilitychange', mark)
        }
    }, [api, sessionId, seq, queryClient])
}
