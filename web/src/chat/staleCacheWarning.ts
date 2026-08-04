import type { ModelPricing } from '@/types/api'
import { isClaudeFlavor } from '@/lib/agentFlavorUtils'

/**
 * Anthropic's prompt cache expires well inside an hour, so a session left sitting that long has
 * certainly lost it. The next message re-reads the entire conversation at full input price instead
 * of the ~10x cheaper cache-read price — invisible at 5k tokens, painful at 150k.
 */
export const STALE_CACHE_IDLE_MS = 60 * 60 * 1000

/** Below this share of the context window the re-read is cheap enough not to interrupt anyone. */
export const STALE_CACHE_MIN_CONTEXT_PERCENT = 10

export type StaleCacheAssessment = {
    /** How long the session has been idle, in milliseconds. */
    idleMs: number
    contextTokens: number
    contextPercent: number
    /** Rough extra spend versus a cache hit, or null when pricing for the model is unknown. */
    extraCostUsd: number | null
}

export function assessStaleCacheRisk(input: {
    flavor: string | null | undefined
    now: number
    /** When the agent last reported usage — the message whose prompt would be in the cache. */
    lastUsageAt: number | undefined
    contextTokens: number | undefined
    contextBudgetTokens: number | null
    pricing: ModelPricing | null
    /** `lastUsageAt` of a warning the user already accepted, so one idle gap warns once. */
    acknowledgedUsageAt: number | null
}): StaleCacheAssessment | null {
    // Other agents price and cache differently; only Claude's behaviour is modelled here.
    if (!isClaudeFlavor(input.flavor)) {
        return null
    }
    if (!input.lastUsageAt || !input.contextTokens || input.contextTokens <= 0) {
        return null
    }
    if (input.acknowledgedUsageAt !== null && input.acknowledgedUsageAt === input.lastUsageAt) {
        return null
    }

    const idleMs = input.now - input.lastUsageAt
    if (idleMs < STALE_CACHE_IDLE_MS) {
        return null
    }

    // Without a known window there is no percentage to threshold on, and guessing one would either
    // nag on huge-context models or stay silent on small ones.
    if (!input.contextBudgetTokens || input.contextBudgetTokens <= 0) {
        return null
    }

    const contextPercent = (input.contextTokens / input.contextBudgetTokens) * 100
    if (contextPercent <= STALE_CACHE_MIN_CONTEXT_PERCENT) {
        return null
    }

    return {
        idleMs,
        contextTokens: input.contextTokens,
        contextPercent,
        extraCostUsd: estimateCacheMissCost(input.contextTokens, input.pricing)
    }
}

/**
 * What the re-read costs beyond what a cache hit would have. Cache *writes* are priced above plain
 * input, so this is a floor rather than the full bill.
 */
function estimateCacheMissCost(contextTokens: number, pricing: ModelPricing | null): number | null {
    if (!pricing) {
        return null
    }
    const premiumPerMillion = pricing.inputPerMillion - pricing.cachedInputPerMillion
    if (!(premiumPerMillion > 0)) {
        return null
    }
    return (contextTokens * premiumPerMillion) / 1_000_000
}

/** "1 hour", "3 hours", "2 days" — coarse on purpose; the exact gap does not change the decision. */
export function formatIdleDuration(idleMs: number, t: (key: string, params?: Record<string, string | number>) => string): string {
    const hours = Math.floor(idleMs / (60 * 60 * 1000))
    if (hours >= 48) {
        return t('duration.days', { count: Math.floor(hours / 24) })
    }
    return t('duration.hours', { count: Math.max(1, hours) })
}
