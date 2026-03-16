import { describe, expect, it } from 'vitest'
import { getContextBudgetTokens } from './modelConfig'

describe('getContextBudgetTokens', () => {
    it('uses the existing 200k budget for default Claude modes', () => {
        expect(getContextBudgetTokens(undefined)).toBe(190_000)
        expect(getContextBudgetTokens('default')).toBe(190_000)
        expect(getContextBudgetTokens('sonnet')).toBe(190_000)
        expect(getContextBudgetTokens('opus')).toBe(190_000)
    })

    it('uses the 1m budget for Claude 1m modes', () => {
        expect(getContextBudgetTokens('sonnet[1m]')).toBe(990_000)
        expect(getContextBudgetTokens('opus[1m]')).toBe(990_000)
    })
})
