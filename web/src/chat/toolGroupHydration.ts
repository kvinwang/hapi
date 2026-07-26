import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { DecryptedMessage } from '@/types/api'

/**
 * Seq range to fetch this group's details from, or null when the group was
 * assembled locally from raw messages that already carry their results.
 *
 * The union across tools matters: a run longer than the hub's expansion budget
 * arrives as two group messages that the client re-packs into one card, and
 * fetching only the first tool's span would leave the rest without results.
 */
export function toolGroupSeqSpan(block: ToolGroupBlock): { firstSeq: number; lastSeq: number } | null {
    let firstSeq: number | null = null
    let lastSeq: number | null = null
    for (const tool of block.tools) {
        const span = tool.tool.groupSpan
        if (!span) continue
        firstSeq = firstSeq === null ? span.firstSeq : Math.min(firstSeq, span.firstSeq)
        lastSeq = lastSeq === null ? span.lastSeq : Math.max(lastSeq, span.lastSeq)
    }
    return firstSeq === null || lastSeq === null ? null : { firstSeq, lastSeq }
}

/** Full input and result per tool, read back from the run's raw messages. */
export type ToolDetail = { input?: unknown; result?: unknown }

/**
 * The hub truncates inputs and strips results to keep pages small, so the
 * detail view must render what came back here, not the compacted descriptor.
 */
export function collectToolDetails(messages: readonly DecryptedMessage[]): Map<string, ToolDetail> {
    const details = new Map<string, ToolDetail>()
    const at = (id: string): ToolDetail => {
        const existing = details.get(id)
        if (existing) return existing
        const created: ToolDetail = {}
        details.set(id, created)
        return created
    }

    for (const message of messages) {
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') continue
        for (const part of normalized.content) {
            if (part.type === 'tool-call') {
                at(part.id).input = part.input
            } else if (part.type === 'tool-result') {
                at(part.tool_use_id).result = part.content
            }
        }
    }
    return details
}
