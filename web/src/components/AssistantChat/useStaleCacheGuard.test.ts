import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useStaleCacheGuard, type StaleCacheGuardInput } from '@/components/AssistantChat/useStaleCacheGuard'

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

const pricing = {
    model: 'claude-sonnet-4-6',
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3,
    updatedAt: NOW
}

function coldCache(overrides: Partial<StaleCacheGuardInput> = {}): StaleCacheGuardInput {
    return {
        flavor: 'claude',
        lastUsageAt: NOW - 2 * HOUR,
        contextTokens: 60_000,
        contextBudgetTokens: 190_000,
        pricing,
        ...overrides
    }
}

function setup(input: StaleCacheGuardInput) {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const send = vi.fn()
    const view = renderHook(({ value }) => useStaleCacheGuard(value, send), {
        initialProps: { value: input }
    })
    return { send, ...view }
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('useStaleCacheGuard', () => {
    it('sends straight through when the cache is still warm', () => {
        const { send, result } = setup(coldCache({ lastUsageAt: NOW - 5 * 60 * 1000 }))

        act(() => result.current.requestSend())

        expect(send).toHaveBeenCalledTimes(1)
        expect(result.current.warning).toBeNull()
    })

    it('holds the send back and surfaces the cost when the cache has expired', () => {
        const { send, result } = setup(coldCache())

        act(() => result.current.requestSend())

        expect(send).not.toHaveBeenCalled()
        expect(result.current.warning?.contextTokens).toBe(60_000)
        expect(result.current.warning?.extraCostUsd).toBeCloseTo(0.162, 4)
    })

    it('sends once the user confirms', async () => {
        const { send, result } = setup(coldCache())

        act(() => result.current.requestSend())
        await act(async () => { await result.current.confirmSend() })

        expect(send).toHaveBeenCalledTimes(1)
    })

    it('does not send when the user backs out', () => {
        const { send, result } = setup(coldCache())

        act(() => result.current.requestSend())
        act(() => result.current.dismissWarning())

        expect(send).not.toHaveBeenCalled()
        expect(result.current.warning).toBeNull()
    })

    it('stops warning for the rest of the idle gap once confirmed', async () => {
        const { send, result } = setup(coldCache())

        act(() => result.current.requestSend())
        await act(async () => { await result.current.confirmSend() })
        act(() => result.current.dismissWarning())

        // The agent has not replied yet, so lastUsageAt is unchanged — a second message must not
        // re-prompt for the same cold cache.
        act(() => result.current.requestSend())

        expect(send).toHaveBeenCalledTimes(2)
        expect(result.current.warning).toBeNull()
    })

    it('warns again after the agent replies and the session goes cold once more', async () => {
        const { send, result, rerender } = setup(coldCache())

        act(() => result.current.requestSend())
        await act(async () => { await result.current.confirmSend() })
        act(() => result.current.dismissWarning())

        // A newer agent reply establishes a fresh cache, which can itself expire later.
        rerender({ value: coldCache({ lastUsageAt: NOW - 90 * 60 * 1000 }) })
        act(() => result.current.requestSend())

        expect(send).toHaveBeenCalledTimes(1)
        expect(result.current.warning).not.toBeNull()
    })
})
