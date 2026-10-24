import type { Session, SubagentEntry, SyncEvent } from '@hapi/protocol/types'

export type SubagentDelta = Extract<SyncEvent, { type: 'subagent-updated' }>['data']

/**
 * How a cached session changed between two refreshes, as the smallest events that carry it:
 * - `none`: nothing a client keeps changed
 * - `partial`: `patch` = the changed top-level fields (merged shallowly by clients, never
 *   `metadata`), `subagents` = the changed `metadata.subagents` entries; either may be null
 * - `whole`: anything else (other metadata fields, a field that was cleared): push the session
 */
export type SessionChange =
    | { kind: 'none' }
    | { kind: 'whole' }
    | { kind: 'partial'; patch: Partial<Session> | null; subagents: SubagentDelta | null }

/** Carried by the subagent delta itself; on their own not worth an event of their own. */
const BOOKKEEPING = new Set(['seq', 'updatedAt', 'metadataVersion'])

function same(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function subagentChanges(
    before: Record<string, SubagentEntry>,
    after: Record<string, SubagentEntry>,
    next: Session
): SubagentDelta | null {
    if (before === after) return null
    const subagents: Record<string, SubagentEntry> = {}
    for (const [id, entry] of Object.entries(after)) {
        const old = before[id]
        if (!old || !same(old, entry)) subagents[id] = entry
    }
    const removed = Object.keys(before).filter((id) => !(id in after))
    if (Object.keys(subagents).length === 0 && removed.length === 0) return null
    return {
        metadataVersion: next.metadataVersion,
        updatedAt: next.updatedAt,
        subagents,
        ...(removed.length > 0 ? { removed } : {})
    }
}

export function sessionChange(previous: Session, next: Session): SessionChange {
    let subagents: SubagentDelta | null = null
    if (previous.metadata !== next.metadata) {
        if (!previous.metadata || !next.metadata) return { kind: 'whole' }
        const { subagents: before, ...restBefore } = previous.metadata
        const { subagents: after, ...restAfter } = next.metadata
        if (!same(restBefore, restAfter)) return { kind: 'whole' }
        subagents = subagentChanges(before ?? {}, after ?? {}, next)
    }

    const patch: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
    for (const key of keys) {
        if (key === 'metadata') continue
        if (subagents && BOOKKEEPING.has(key)) continue
        const before = (previous as Record<string, unknown>)[key]
        const after = (next as Record<string, unknown>)[key]
        if (same(before, after)) continue
        // A shallow merge keeps the old value of a missing key, so a cleared field needs the whole session.
        if (after === undefined) return { kind: 'whole' }
        patch[key] = after
    }

    const hasPatch = Object.keys(patch).length > 0
    if (!subagents && !hasPatch) return { kind: 'none' }
    return { kind: 'partial', patch: hasPatch ? patch as Partial<Session> : null, subagents }
}
