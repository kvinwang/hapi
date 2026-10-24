import type { Session, SubagentEntry, SyncEvent } from '@hapi/protocol/types'

type SubagentDelta = Extract<SyncEvent, { type: 'subagent-updated' }>['data']

/** Fields that change with any metadata write and are carried by the delta itself. */
function withoutSubagents(session: Session): unknown {
    const { metadataVersion: _version, updatedAt: _updatedAt, seq: _seq, ...rest } = session
    if (!rest.metadata) return rest
    const { subagents: _subagents, ...metadata } = rest.metadata
    return { ...rest, metadata }
}

/**
 * The change from `previous` to `next` when it touches nothing but `metadata.subagents`,
 * as the changed entries (whole entries, each replaces its key) and the removed keys; null
 * when anything else differs, or nothing does.
 */
export function subagentDelta(previous: Session, next: Session): SubagentDelta | null {
    const before = previous.metadata?.subagents ?? {}
    const after = next.metadata?.subagents ?? {}
    if (before === after) return null
    if (JSON.stringify(withoutSubagents(previous)) !== JSON.stringify(withoutSubagents(next))) return null

    const subagents: Record<string, SubagentEntry> = {}
    for (const [id, entry] of Object.entries(after)) {
        const old = before[id]
        if (!old || JSON.stringify(old) !== JSON.stringify(entry)) subagents[id] = entry
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
