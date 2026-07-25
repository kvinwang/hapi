import {
    buildSealedToolGroups,
    compactMessagesWithToolGroupSummaries,
    type TimelineMessage,
    type ToolGroupTimelineEntry
} from '@hapi/protocol'
import type { DecryptedMessage } from '@hapi/protocol/schemas'

function hasSeq(message: DecryptedMessage): message is DecryptedMessage & { seq: number } {
    return typeof message.seq === 'number' && Number.isFinite(message.seq)
}

export function toTimelineMessage(message: DecryptedMessage & { seq: number }): TimelineMessage {
    return {
        id: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        localId: message.localId,
        content: message.content
    }
}

export function projectMessagesPage(messages: DecryptedMessage[]): {
    messages: DecryptedMessage[]
    toolGroups: ToolGroupTimelineEntry[]
} {
    const sequenced = messages.filter(hasSeq)
    const timeline = sequenced.map(toTimelineMessage)
    const toolGroups = buildSealedToolGroups(timeline)
    const compacted = compactMessagesWithToolGroupSummaries(timeline)
    return {
        messages: compacted.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            content: message.content,
            createdAt: message.createdAt
        })),
        toolGroups
    }
}

/**
 * Expand a raw page so we do not cut a sealed tool group mid-span.
 * `fetchMore` loads additional messages around the cut edge.
 */
export function expandPageToCompleteToolGroups(
    page: DecryptedMessage[],
    options: {
        direction: 'before' | 'after'
        fetchMore: (count: number, fromSeq: number) => DecryptedMessage[]
        maxExpandBatches?: number
    }
): DecryptedMessage[] {
    if (page.length === 0) return page
    const maxBatches = options.maxExpandBatches ?? 8
    let messages = page.filter(hasSeq).sort((a, b) => a.seq - b.seq)

    for (let batch = 0; batch < maxBatches; batch += 1) {
        const groups = buildSealedToolGroups(messages.map(toTimelineMessage))
        const oldest = messages[0]
        const newest = messages[messages.length - 1]
        if (!oldest || !newest) return messages

        let expanded = false

        const coveringOldest = groups.find((group) => oldest.seq > group.firstSeq && oldest.seq <= group.lastSeq)
        if (coveringOldest) {
            const more = options.fetchMore(80, oldest.seq).filter(hasSeq)
            if (more.length === 0) break
            const byId = new Map(messages.map((message) => [message.id, message]))
            for (const message of more) byId.set(message.id, message)
            const next = [...byId.values()].sort((a, b) => a.seq - b.seq)
            if (next.length === messages.length) break
            messages = next
            expanded = true
        }

        const coveringNewest = groups.find((group) => newest.seq >= group.firstSeq && newest.seq < group.lastSeq)
        if (coveringNewest) {
            const more = options.fetchMore(80, newest.seq).filter(hasSeq)
            if (more.length > 0) {
                const byId = new Map(messages.map((message) => [message.id, message]))
                for (const message of more) byId.set(message.id, message)
                const next = [...byId.values()].sort((a, b) => a.seq - b.seq)
                if (next.length !== messages.length) {
                    messages = next
                    expanded = true
                }
            }
        }

        if (!expanded) break
    }

    return messages
}

export function filterMessagesForToolGroup(
    messages: readonly DecryptedMessage[],
    group: Pick<ToolGroupTimelineEntry, 'firstSeq' | 'lastSeq'>
): DecryptedMessage[] {
    return messages.filter((message) => (
        typeof message.seq === 'number'
        && message.seq >= group.firstSeq
        && message.seq <= group.lastSeq
    ))
}
