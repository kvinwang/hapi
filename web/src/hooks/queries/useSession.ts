import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { findCachedSessionSummary, sessionFromSummary } from '@/lib/session-placeholder'

export function useSession(api: ApiClient | null, sessionId: string | null): {
    session: Session | null
    isLoading: boolean
    isPlaceholder: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.session(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            return await api.getSession(sessionId)
        },
        enabled: Boolean(api && sessionId),
        // Opening a session the user has never visited otherwise blanks the whole page — header
        // included — for a full round-trip. The sessions list already holds everything the chrome
        // needs, so paint from that and let the real response take over when it lands.
        placeholderData: () => {
            const summary = findCachedSessionSummary(queryClient, sessionId)
            return summary ? { session: sessionFromSummary(summary) } : undefined
        }
    })

    return {
        session: query.data?.session ?? null,
        isLoading: query.isLoading,
        isPlaceholder: query.isPlaceholderData,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load session' : null,
        refetch: query.refetch,
    }
}
