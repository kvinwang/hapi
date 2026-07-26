import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import type { DecryptedMessage } from '@/types/api'

/**
 * Seq range the hub compacted this group from, or null when the group was
 * assembled locally from raw messages that already carry their results.
 */
export function toolGroupSeqSpan(block: ToolGroupBlock): { firstSeq: number; lastSeq: number } | null {
    for (const tool of block.tools) {
        if (tool.tool.groupSpan) return tool.tool.groupSpan
    }
    return null
}

/** Tool results keyed by tool-use id, read back from the run's raw messages. */
export function collectToolResults(messages: readonly DecryptedMessage[]): Map<string, unknown> {
    const results = new Map<string, unknown>()
    for (const message of messages) {
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') continue
        for (const part of normalized.content) {
            if (part.type !== 'tool-result') continue
            results.set(part.tool_use_id, part.content)
        }
    }
    return results
}
