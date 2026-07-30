import type { NormalizedMessage, UsageData } from '@hapi/protocol/chat'

export type MessageUsagePoint = {
    seq: number
    usage: UsageData
}

export function collectMessageUsagePoints(messages: readonly NormalizedMessage[]): MessageUsagePoint[] {
    const points: MessageUsagePoint[] = []
    for (const message of messages) {
        if (typeof message.seq !== 'number' || !message.usage) continue
        // Aggregate session totals are not context snapshots. Agents can emit them
        // beside a turn-level usage event, but their token counts are cumulative.
        if (message.usage.total_tokens !== undefined && message.usage.context_tokens === undefined) continue
        points.push({ seq: message.seq, usage: message.usage })
    }
    points.sort((a, b) => a.seq - b.seq)
    return points
}

export function findMessageUsageAtSeq(
    points: readonly MessageUsagePoint[],
    seq: number
): UsageData | null {
    let low = 0
    let high = points.length - 1
    let match: UsageData | null = null

    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const point = points[middle]
        if (point.seq <= seq) {
            match = point.usage
            low = middle + 1
        } else {
            high = middle - 1
        }
    }

    return match
}

export function getContextTokens(usage: UsageData): number {
    return usage.context_tokens
        ?? (usage.cache_creation_input_tokens ?? 0)
            + (usage.cache_read_input_tokens ?? 0)
            + usage.input_tokens
}
