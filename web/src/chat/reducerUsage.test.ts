import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from './types'
import { reduceChatBlocks } from './reducer'

function usageMessage(id: string, input: number, output: number, cacheRead: number): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: Number(id),
        role: 'agent',
        content: [],
        isSidechain: false,
        usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead
        }
    }
}

describe('reduceChatBlocks usage', () => {
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
})
