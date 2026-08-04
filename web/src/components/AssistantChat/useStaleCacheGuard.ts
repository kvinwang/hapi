import { useCallback, useRef, useState } from 'react'
import type { ModelPricing } from '@/types/api'
import { assessStaleCacheRisk, type StaleCacheAssessment } from '@/chat/staleCacheWarning'

export type StaleCacheGuardInput = {
    flavor: string | null | undefined
    lastUsageAt: number | undefined
    contextTokens: number | undefined
    contextBudgetTokens: number | null
    pricing: ModelPricing | null
}

/**
 * Gate a send behind a confirmation when the session's prompt cache has gone cold.
 *
 * The risk is evaluated at send time rather than during render, because it turns on elapsed time —
 * a value computed at render would be stale by the time the user actually presses send.
 */
export function useStaleCacheGuard(input: StaleCacheGuardInput, send: () => void): {
    warning: StaleCacheAssessment | null
    requestSend: () => void
    confirmSend: () => Promise<void>
    dismissWarning: () => void
} {
    const [warning, setWarning] = useState<StaleCacheAssessment | null>(null)
    // Accepting the warning covers the whole idle gap: the agent has not replied yet, so the
    // timestamp the assessment keys off has not moved and would otherwise re-trigger immediately.
    const acknowledgedUsageAtRef = useRef<number | null>(null)

    const requestSend = useCallback(() => {
        const risk = assessStaleCacheRisk({
            flavor: input.flavor,
            now: Date.now(),
            lastUsageAt: input.lastUsageAt,
            contextTokens: input.contextTokens,
            contextBudgetTokens: input.contextBudgetTokens,
            pricing: input.pricing,
            acknowledgedUsageAt: acknowledgedUsageAtRef.current
        })
        if (risk) {
            setWarning(risk)
            return
        }
        send()
    }, [
        input.contextBudgetTokens,
        input.contextTokens,
        input.flavor,
        input.lastUsageAt,
        input.pricing,
        send
    ])

    const confirmSend = useCallback(async () => {
        acknowledgedUsageAtRef.current = input.lastUsageAt ?? null
        send()
    }, [input.lastUsageAt, send])

    const dismissWarning = useCallback(() => setWarning(null), [])

    return { warning, requestSend, confirmSend, dismissWarning }
}
