import type { SessionSummary } from '@/types/api'

export const STALE_SESSION_AGE_MS = 10 * 24 * 60 * 60 * 1000

type StaleCandidate = Pick<SessionSummary, 'id' | 'parentSessionId' | 'active' | 'updatedAt' | 'pinned'>

/**
 * Pick the running sessions that have had no real activity (`updatedAt`, not the
 * heartbeat `activeAt`) for longer than `maxAgeMs`, ordered children first.
 *
 * Archiving a session on the hub also kills its active descendants, so a stale
 * parent is only selected when every active descendant is selected too. Pinned
 * sessions are never selected. Children-first ordering means each archive call
 * touches exactly one session and a later call never hits an already-ended one.
 */
export function selectStaleSessions<T extends StaleCandidate>(
    sessions: readonly T[],
    now: number,
    maxAgeMs: number = STALE_SESSION_AGE_MS
): T[] {
    const cutoff = now - maxAgeMs
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const children = new Map<string, T[]>()
    for (const session of sessions) {
        const parentId = session.parentSessionId
        if (!parentId || !byId.has(parentId)) continue
        const list = children.get(parentId)
        if (list) list.push(session)
        else children.set(parentId, [session])
    }

    const isStale = (session: T) => session.active && !session.pinned && session.updatedAt < cutoff

    // A session is safe to archive when it is stale and archiving it would not
    // take down any active descendant that is not itself safe to archive.
    const safe = new Map<string, boolean>()
    const depth = new Map<string, number>()
    const visit = (session: T, ancestors: Set<string>): boolean => {
        const cached = safe.get(session.id)
        if (cached !== undefined) return cached
        if (ancestors.has(session.id)) return false // defensive: cyclic parent links
        ancestors.add(session.id)
        let subtreeOk = true
        for (const child of children.get(session.id) ?? []) {
            const childOk = visit(child, ancestors)
            if (child.active && !childOk) subtreeOk = false
        }
        ancestors.delete(session.id)
        const result = subtreeOk && isStale(session)
        safe.set(session.id, result)
        return result
    }

    const depthOf = (session: T): number => {
        const cached = depth.get(session.id)
        if (cached !== undefined) return cached
        let d = 0
        let parentId = session.parentSessionId
        const seen = new Set<string>([session.id])
        while (parentId && byId.has(parentId) && !seen.has(parentId)) {
            seen.add(parentId)
            d += 1
            parentId = byId.get(parentId)?.parentSessionId
        }
        depth.set(session.id, d)
        return d
    }

    return sessions
        .filter((session) => visit(session, new Set()))
        .sort((a, b) => depthOf(b) - depthOf(a) || a.updatedAt - b.updatedAt)
}
