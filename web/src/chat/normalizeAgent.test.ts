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
