import type { LatestUsage } from './reducer'
import type { ModelPricing } from '@/types/api'

export type UsageCost = {
    nonCachedInput: number
    cachedInput: number
    output: number
    total: number
}

export function calculateUsageCost(usage: LatestUsage | null | undefined, pricing: ModelPricing | null | undefined): UsageCost | null {
    if (!usage || !pricing || usage.totalInputTokens === undefined || usage.totalCachedInputTokens === undefined || usage.totalOutputTokens === undefined) return null
    const nonCachedTokens = Math.max(0, usage.totalInputTokens - usage.totalCachedInputTokens)
    const nonCachedInput = nonCachedTokens * pricing.inputPerMillion / 1_000_000
    const cachedInput = usage.totalCachedInputTokens * pricing.cachedInputPerMillion / 1_000_000
    const output = usage.totalOutputTokens * pricing.outputPerMillion / 1_000_000
    return { nonCachedInput, cachedInput, output, total: nonCachedInput + cachedInput + output }
}

export function formatUsd(value: number): string {
    return `$${new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: value < 0.1 ? 4 : 2 }).format(value)}`
}
