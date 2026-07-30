import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@hapi/protocol/chat'
import { collectMessageUsagePoints, findMessageUsageAtSeq, getContextTokens } from './messageUsage'

function usageMessage(seq: number, contextTokens: number): NormalizedMessage {
    return {
        id: String(seq),
        localId: null,
        createdAt: seq,
        seq,
        role: 'agent',
        content: [],
        isSidechain: false,
        usage: { input_tokens: 1, output_tokens: 2, context_tokens: contextTokens }
    }
}

describe('message usage lookup', () => {
    it('returns the latest usage snapshot at or before the fork sequence', () => {
        const points = collectMessageUsagePoints([
            usageMessage(30, 300),
            usageMessage(10, 100),
            usageMessage(20, 200)
        ])

        expect(findMessageUsageAtSeq(points, 9)).toBeNull()
        expect(findMessageUsageAtSeq(points, 20)?.context_tokens).toBe(200)
        expect(findMessageUsageAtSeq(points, 29)?.context_tokens).toBe(200)
    })

    it('falls back to the input and cache buckets for context size', () => {
        expect(getContextTokens({
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30
        })).toBe(60)
    })

    it('does not treat cumulative session totals as context snapshots', () => {
        const aggregate = usageMessage(20, 999)
        aggregate.usage = {
            input_tokens: 999,
            output_tokens: 10,
            total_tokens: 1009
        }
        const points = collectMessageUsagePoints([usageMessage(10, 100), aggregate])

        expect(findMessageUsageAtSeq(points, 20)?.context_tokens).toBe(100)
    })
})
