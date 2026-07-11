import { describe, expect, it } from 'vitest'
import { extractAcpUsage } from './AcpSdkBackend'
import { convertAgentMessage } from '@/agent/messageConverter'

describe('extractAcpUsage', () => {
    it('parses Grok prompt result _meta', () => {
        const usage = extractAcpUsage({
            stopReason: 'end_turn',
            _meta: {
                totalTokens: 13064,
                modelId: 'grok-4.5',
                inputTokens: 13032,
                outputTokens: 31,
                cachedReadTokens: 2816,
                reasoningTokens: 26
            }
        })
        expect(usage).toEqual({
            // Prefer totalTokens for context occupancy when present
            inputTokens: 13064,
            outputTokens: 31,
            cacheReadTokens: 2816,
            cacheCreationTokens: undefined,
            totalTokens: 13064,
            modelId: 'grok-4.5'
        })
    })

    it('returns undefined without token fields', () => {
        expect(extractAcpUsage({ stopReason: 'end_turn' })).toBeUndefined()
    })
})

describe('convertAgentMessage turn_complete usage', () => {
    it('emits usage with totalTokens as context occupancy', () => {
        const msg = convertAgentMessage({
            type: 'turn_complete',
            stopReason: 'end_turn',
            usage: {
                inputTokens: 100,
                outputTokens: 10,
                totalTokens: 500,
                modelId: 'grok-4.5'
            }
        })
        expect(msg).toEqual({
            type: 'usage',
            input_tokens: 500,
            output_tokens: 10,
            model: 'grok-4.5'
        })
    })
})
