import { useCallback, useRef, useState } from 'react'
import type { ModelPricing } from '@/types/api'
import { assessStaleCacheRisk, getStaleCacheIdleMs, type StaleCacheAssessment } from '@/chat/staleCacheWarning'

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
 * `payload` describes what is being sent; it is held while the warning is up and handed back on confirm.
 */
export function useStaleCacheGuard<T = void>(input: StaleCacheGuardInput, send: (payload: T) => void): {
    warning: StaleCacheAssessment | null
    requestSend: (payload: T) => void
    /** `revise` lets the caller adjust the held payload, e.g. to mark the send as a fresh start. */
    confirmSend: (revise?: (payload: T) => T) => void
    dismissWarning: () => void
} {
    const [warning, setWarning] = useState<StaleCacheAssessment | null>(null)
    const pendingRef = useRef<{ payload: T } | null>(null)
    // Accepting the warning covers the whole idle gap: the agent has not replied yet, so the
    // timestamp the assessment keys off has not moved and would otherwise re-trigger immediately.
    const acknowledgedUsageAtRef = useRef<number | null>(null)

    const requestSend = useCallback((payload: T) => {
        const risk = assessStaleCacheRisk({
            flavor: input.flavor,
            now: Date.now(),
            idleThresholdMs: getStaleCacheIdleMs(),
            lastUsageAt: input.lastUsageAt,
            contextTokens: input.contextTokens,
            contextBudgetTokens: input.contextBudgetTokens,
            pricing: input.pricing,
            acknowledgedUsageAt: acknowledgedUsageAtRef.current
        })
        if (risk) {
            pendingRef.current = { payload }
            setWarning(risk)
            return
        }
        send(payload)
    }, [
        input.contextBudgetTokens,
        input.contextTokens,
        input.flavor,
        input.lastUsageAt,
        input.pricing,
        send
    ])

    const confirmSend = useCallback((revise?: (payload: T) => T) => {
        const pending = pendingRef.current
        pendingRef.current = null
        if (!pending) return
        acknowledgedUsageAtRef.current = input.lastUsageAt ?? null
        send(revise ? revise(pending.payload) : pending.payload)
    }, [input.lastUsageAt, send])

    const dismissWarning = useCallback(() => setWarning(null), [])

    return { warning, requestSend, confirmSend, dismissWarning }
}
