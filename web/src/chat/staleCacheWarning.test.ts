import { describe, expect, it } from 'vitest'
import { assessStaleCacheRisk, formatIdleDuration } from '@/chat/staleCacheWarning'

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

const pricing = {
    model: 'claude-sonnet-4-6',
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    updatedAt: NOW
}

function assess(overrides: Partial<Parameters<typeof assessStaleCacheRisk>[0]> = {}) {
    return assessStaleCacheRisk({
        flavor: 'claude',
        now: NOW,
        lastUsageAt: NOW - 2 * HOUR,
        contextTokens: 60_000,
        contextBudgetTokens: 190_000,
        pricing,
        acknowledgedUsageAt: null,
        ...overrides
    })
}

describe('assessStaleCacheRisk', () => {
    it('warns for an idle Claude session holding a large context', () => {
        const result = assess()

        expect(result).not.toBeNull()
        expect(result!.idleMs).toBe(2 * HOUR)
        expect(result!.contextTokens).toBe(60_000)
        expect(result!.contextPercent).toBeCloseTo(31.6, 1)
    })

    it('estimates the spend beyond what a cache hit would have cost', () => {
        // 60k tokens at $3/M instead of $0.30/M cached ⇒ $2.70/M premium ⇒ $0.162
        expect(assess()!.extraCostUsd).toBeCloseTo(0.162, 4)
    })

    it('stays quiet until the cache has actually had time to expire', () => {
        expect(assess({ lastUsageAt: NOW - 59 * 60 * 1000 })).toBeNull()
        expect(assess({ lastUsageAt: NOW - HOUR })).not.toBeNull()
    })

    it('stays quiet when re-reading the context would be cheap', () => {
        expect(assess({ contextTokens: 19_000 })).toBeNull()   // exactly 10% — not above the bar
        expect(assess({ contextTokens: 19_001 })).not.toBeNull()
    })

    it('only applies to Claude, whose caching and pricing this models', () => {
        expect(assess({ flavor: 'codex' })).toBeNull()
        expect(assess({ flavor: null })).toBeNull()
        expect(assess({ flavor: undefined })).toBeNull()
    })

    it('warns once per idle gap, so confirming does not re-prompt on the next message', () => {
        const lastUsageAt = NOW - 2 * HOUR
        expect(assess({ lastUsageAt, acknowledgedUsageAt: lastUsageAt })).toBeNull()
        // A newer agent reply means a fresh cache, and later a fresh warning.
        expect(assess({ lastUsageAt: NOW - 3 * HOUR, acknowledgedUsageAt: lastUsageAt })).not.toBeNull()
    })

    it('says nothing when it has no usage or no context window to reason about', () => {
        expect(assess({ lastUsageAt: undefined })).toBeNull()
        expect(assess({ contextTokens: undefined })).toBeNull()
        expect(assess({ contextTokens: 0 })).toBeNull()
        expect(assess({ contextBudgetTokens: null })).toBeNull()
        expect(assess({ contextBudgetTokens: 0 })).toBeNull()
    })

    it('reports the risk without a cost when the model has no pricing on file', () => {
        const result = assess({ pricing: null })

        expect(result).not.toBeNull()
        expect(result!.extraCostUsd).toBeNull()
    })
})

describe('formatIdleDuration', () => {
    const t = (key: string, params?: Record<string, string | number>) => `${key}:${params?.count}`

    it('rounds down to whole hours, never below one', () => {
        expect(formatIdleDuration(HOUR, t)).toBe('duration.hours:1')
        expect(formatIdleDuration(5.9 * HOUR, t)).toBe('duration.hours:5')
    })

    it('switches to days once hours stop being readable', () => {
        expect(formatIdleDuration(47 * HOUR, t)).toBe('duration.hours:47')
        expect(formatIdleDuration(48 * HOUR, t)).toBe('duration.days:2')
    })
})
