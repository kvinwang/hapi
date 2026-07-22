import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from './types'
import { reduceChatBlocks } from './reducer'

function usageMessage(id: string, input: number, output: number, cacheRead: number, usageId?: string): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: Number(id),
        role: 'agent',
        content: [],
        isSidechain: false,
        usage: {
            usage_id: usageId,
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead
        }
    }
}

describe('reduceChatBlocks usage', () => {
    const cumulativeUsageMessage = (
        id: string,
        input: number,
        output: number,
        cost?: number,
        authoritative = false
    ): NormalizedMessage => ({
        ...usageMessage(id, 0, 0, 0),
        usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_input_tokens: input,
            total_output_tokens: output,
            total_cached_input_tokens: 0,
            total_tokens: input + output,
            reported_cost_usd: cost,
            authoritative_turn_totals: authoritative
        }
    })

    it('uses the latest cumulative Claude result totals instead of summing snapshots', () => {
        const result = reduceChatBlocks([
            cumulativeUsageMessage('1', 100, 10, 2.2, true),
            cumulativeUsageMessage('2', 200, 20, 3.6, true)
        ], null)

        expect(result.latestUsage).toMatchObject({
            totalInputTokens: 200,
            totalOutputTokens: 20,
            totalTokens: 220,
            reportedCostUsd: 3.6
        })
    })

    it('ignores a transient zero cumulative Claude result', () => {
        const result = reduceChatBlocks([
            cumulativeUsageMessage('1', 200, 20, 3.6, true),
            cumulativeUsageMessage('2', 0, 0, 0, true)
        ], null)

        expect(result.latestUsage).toMatchObject({
            totalInputTokens: 200,
            totalOutputTokens: 20,
            totalTokens: 220,
            reportedCostUsd: 3.6
        })
    })

    it('keeps the cumulative Codex high-water mark when a later snapshot resets', () => {
        const result = reduceChatBlocks([
            cumulativeUsageMessage('1', 400, 40),
            cumulativeUsageMessage('2', 0, 0)
        ], null)

        expect(result.latestUsage).toMatchObject({
            totalInputTokens: 400,
            totalOutputTokens: 40,
            totalTokens: 440
        })
    })

    it('sums Claude turn usage into session totals while retaining latest context', () => {
        const result = reduceChatBlocks([
            usageMessage('1', 100, 10, 900),
            usageMessage('2', 120, 20, 1_000)
        ], null)

        expect(result.latestUsage).toMatchObject({
            contextSize: 1_120,
            totalTokens: 2_150,
            totalInputTokens: 2_120,
            totalOutputTokens: 30,
            totalCachedInputTokens: 1_900
        })
    })

    it('does not double-charge split Claude records with the same API message id', () => {
        const result = reduceChatBlocks([
            usageMessage('1', 100, 10, 900, 'msg-1'),
            usageMessage('2', 100, 10, 900, 'msg-1')
        ], null)
        expect(result.latestUsage?.totalTokens).toBe(1_010)
    })
})
