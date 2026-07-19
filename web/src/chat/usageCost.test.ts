import { describe, expect, it } from 'vitest'
import { calculateUsageCost } from './usageCost'

describe('calculateUsageCost', () => {
    it('prices non-cached input, cached input, and output separately', () => {
        const cost = calculateUsageCost({
            inputTokens: 0,
            outputTokens: 0,
            cacheCreation: 0,
            cacheRead: 0,
            contextSize: 0,
            timestamp: 0,
            totalInputTokens: 2_000_000,
            totalCachedInputTokens: 1_500_000,
            totalOutputTokens: 100_000
        }, {
            model: 'test',
            inputPerMillion: 10,
            cachedInputPerMillion: 1,
            outputPerMillion: 50,
            updatedAt: 0
        })

        expect(cost).toEqual({ nonCachedInput: 5, cachedInput: 1.5, output: 5, total: 11.5 })
    })
})
