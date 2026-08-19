import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { usePullToRefresh, type PullToRefreshState } from './usePullToRefresh'

type Harness = {
    container: HTMLDivElement
    state: PullToRefreshState
    refresh: () => void
}

let harness: Harness

function Probe({ onRefresh, scrollTop = 0 }: { onRefresh: () => unknown; scrollTop?: number }) {
    const { containerRef, state, refresh } = usePullToRefresh<HTMLDivElement>({ onRefresh })
    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true })
        harness = { container: el, state, refresh }
    })
    if (harness) harness.state = state
    return <div ref={containerRef} data-testid="scroller" />
}

function touch(type: string, clientX: number, clientY: number) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', {
        value: type === 'touchend' ? [] : [{ clientX, clientY }],
    })
    return event
}

function drag(from: number, to: number) {
    act(() => {
        harness.container.dispatchEvent(touch('touchstart', 0, from))
        harness.container.dispatchEvent(touch('touchmove', 0, to))
    })
}

function release() {
    act(() => {
        harness.container.dispatchEvent(touch('touchend', 0, 0))
    })
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

describe('usePullToRefresh', () => {
    it('tracks the pull and arms once past the threshold', () => {
        render(<Probe onRefresh={() => {}} />)

        drag(100, 130)
        expect(harness.state.phase).toBe('pulling')
        expect(harness.state.distance).toBeGreaterThan(0)
        expect(harness.state.distance).toBeLessThan(harness.state.threshold)

        drag(100, 300)
        expect(harness.state.phase).toBe('ready')
        expect(harness.state.progress).toBe(1)
    })

    it('does not refresh when released below the threshold', () => {
        const onRefresh = vi.fn()
        render(<Probe onRefresh={onRefresh} />)

        drag(100, 130)
        release()

        expect(onRefresh).not.toHaveBeenCalled()
        expect(harness.state.phase).toBe('idle')
        expect(harness.state.distance).toBe(0)
    })

    it('refreshes on release and walks through refreshing → done → idle', async () => {
        let resolve: () => void = () => {}
        const onRefresh = vi.fn(() => new Promise<void>((r) => { resolve = r }))
        render(<Probe onRefresh={onRefresh} />)

        drag(100, 300)
        release()

        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(harness.state.phase).toBe('refreshing')
        expect(harness.state.distance).toBe(harness.state.threshold)

        await act(async () => { resolve() })
        // The spinner is held for a minimum duration so a fast refetch does not flicker.
        expect(harness.state.phase).toBe('refreshing')

        await act(async () => { await vi.advanceTimersByTimeAsync(400) })
        expect(harness.state.phase).toBe('done')

        await act(async () => { await vi.advanceTimersByTimeAsync(600) })
        expect(harness.state.phase).toBe('idle')
        expect(harness.state.distance).toBe(0)
    })

    it('ignores upward and horizontal gestures', () => {
        const onRefresh = vi.fn()
        render(<Probe onRefresh={onRefresh} />)

        act(() => {
            harness.container.dispatchEvent(touch('touchstart', 0, 200))
            harness.container.dispatchEvent(touch('touchmove', 0, 100))
        })
        expect(harness.state.phase).toBe('idle')

        act(() => {
            harness.container.dispatchEvent(touch('touchstart', 0, 100))
            harness.container.dispatchEvent(touch('touchmove', 200, 120))
        })
        expect(harness.state.phase).toBe('idle')

        release()
        expect(onRefresh).not.toHaveBeenCalled()
    })

    it('ignores pulls that start mid-scroll', () => {
        const onRefresh = vi.fn()
        render(<Probe onRefresh={onRefresh} scrollTop={120} />)

        drag(100, 300)
        release()

        expect(onRefresh).not.toHaveBeenCalled()
        expect(harness.state.phase).toBe('idle')
    })

    it('exposes a programmatic refresh that reuses the indicator', async () => {
        const onRefresh = vi.fn(() => Promise.resolve())
        render(<Probe onRefresh={onRefresh} />)

        act(() => { harness.refresh() })
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(harness.state.phase).toBe('refreshing')

        // A second trigger while refreshing is a no-op.
        act(() => { harness.refresh() })
        expect(onRefresh).toHaveBeenCalledTimes(1)

        await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
        expect(harness.state.phase).toBe('idle')
    })
})
