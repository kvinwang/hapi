import type { QueryClient } from '@tanstack/react-query'
import type { Session, SessionSummary, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

/**
 * Widen a `SessionSummary` (what the sessions list returns) into a `Session` shape so the
 * detail page can paint its chrome before `GET /api/sessions/:id` comes back.
 *
 * The summary is a lossy projection: it carries no `agentState`, `todos`, `teamState` or
 * `permissionMode`, so those come back empty here. That is fine for a placeholder — react-query
 * swaps in the real session as soon as the request resolves — but it means this value must never
 * be treated as authoritative (e.g. do not persist it or diff against it).
 */
export function sessionFromSummary(summary: SessionSummary): Session {
    return {
        id: summary.id,
        parentSessionId: summary.parentSessionId ?? null,
        namespace: '',
        seq: 0,
        createdAt: summary.updatedAt,
        updatedAt: summary.updatedAt,
        active: summary.active,
        activeAt: summary.activeAt,
        metadata: summary.metadata
            ? {
                path: summary.metadata.path,
                host: '',
                name: summary.metadata.name,
                machineId: summary.metadata.machineId,
                summary: summary.metadata.summary
                    ? { text: summary.metadata.summary.text, updatedAt: summary.updatedAt }
                    : undefined,
                flavor: summary.metadata.flavor,
                worktree: summary.metadata.worktree
            }
            : null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: summary.thinking,
        thinkingAt: summary.activeAt,
        modelMode: summary.modelMode,
        effortMode: summary.effortMode
    }
}

/** Look up a session in the cached sessions list, if it is there. */
export function findCachedSessionSummary(
    queryClient: QueryClient,
    sessionId: string | null
): SessionSummary | null {
    if (!sessionId) {
        return null
    }
    const cached = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
    return cached?.sessions.find((item) => item.id === sessionId) ?? null
}
