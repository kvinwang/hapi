import { describe, expect, it } from 'vitest'
import { normalizeAgentRecord } from './normalizeAgent'

describe('normalizeAgentRecord Codex usage', () => {
    it('preserves current context and cumulative thread totals', () => {
        const message = normalizeAgentRecord('message-1', null, 123, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: {
                    total: {
                        totalTokens: 2_966_342,
                        inputTokens: 2_955_109,
                        cachedInputTokens: 2_828_544,
                        outputTokens: 11_233,
                        reasoningOutputTokens: 1_713
                    },
                    last: {
                        totalTokens: 84_258,
                        inputTokens: 84_162,
                        cachedInputTokens: 83_712,
                        outputTokens: 96
                    }
                }
            }
        })

        expect(message?.usage).toMatchObject({
            context_tokens: 84_258,
            total_tokens: 2_966_342,
            total_input_tokens: 2_955_109,
            total_cached_input_tokens: 2_828_544,
            total_output_tokens: 11_233,
            total_reasoning_output_tokens: 1_713
        })
    })
})

describe('normalizeAgentRecord Claude result usage', () => {
    it('uses authoritative per-turn model totals', () => {
        const message = normalizeAgentRecord('result-1', null, 123, {
            type: 'output',
            data: {
                type: 'result',
                subtype: 'success',
                total_cost_usd: 0.873451,
                modelUsage: {
                    'claude-fable-5': {
                        inputTokens: 12,
                        outputTokens: 4090,
                        cacheReadInputTokens: 123431,
                        cacheCreationInputTokens: 27270
                    }
                }
            }
        })

        expect(message?.usage).toMatchObject({
            total_input_tokens: 150713,
            total_cached_input_tokens: 123431,
            total_cache_read_input_tokens: 123431,
            total_cache_creation_input_tokens: 27270,
            total_output_tokens: 4090,
            total_tokens: 154803,
            reported_cost_usd: 0.873451
        })
    })
})
