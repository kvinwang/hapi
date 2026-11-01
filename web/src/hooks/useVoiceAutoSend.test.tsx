import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useVoiceAutoSend, useVoiceAutoSendSettings } from './useVoiceAutoSend'

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(10000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
function settings(delay = 3, enabled = true) {
    localStorage.setItem('hapi.voiceAutoSend', JSON.stringify({ enabled, delay }))
    window.dispatchEvent(new Event('hapi-voice-auto-send'))
}

describe('voice auto-send', () => {
    it.each([2, 3, 5])('sends once after %i seconds without speech', async (delay) => {
        settings(delay)
        const send = vi.fn(async () => {})
        const { rerender } = renderHook((draft) => useVoiceAutoSend({ silenceSince: 10000, ready: true, draft, send }), { initialProps: 'Full draft' })
        await act(async () => vi.advanceTimersByTimeAsync(delay * 1000 - 1))
        expect(send).not.toHaveBeenCalled()
        await act(async () => vi.advanceTimersByTimeAsync(1))
        expect(send).toHaveBeenCalledOnce()
        rerender('Changed draft')
        await act(async () => vi.advanceTimersByTimeAsync(10000))
        expect(send).toHaveBeenCalledOnce()
    })

    it('cancels when speech resumes and waits for the next complete pause', async () => {
        settings(3)
        const send = vi.fn(async () => {})
        const { rerender } = renderHook((pause: number | null) => useVoiceAutoSend({ silenceSince: pause, ready: pause !== null, draft: 'Draft', send }), { initialProps: 10000 as number | null })
        await act(async () => vi.advanceTimersByTimeAsync(2000))
        rerender(null)
        await act(async () => vi.advanceTimersByTimeAsync(3000))
        expect(send).not.toHaveBeenCalled()
        rerender(15000)
        await act(async () => vi.advanceTimersByTimeAsync(3000))
        expect(send).toHaveBeenCalledOnce()
    })

    it('waits for recognition completion even when the pause has elapsed', async () => {
        settings(2)
        const send = vi.fn(async () => {})
        const { rerender } = renderHook((ready: boolean) => useVoiceAutoSend({ silenceSince: 10000, ready, draft: 'Draft', send }), { initialProps: false })
        await act(async () => vi.advanceTimersByTimeAsync(5000))
        expect(send).not.toHaveBeenCalled()
        rerender(true)
        await act(async () => vi.advanceTimersByTimeAsync(1))
        expect(send).toHaveBeenCalledOnce()
    })

    it('is off by default and remembers enabled state and delay across remounts', () => {
        const first = renderHook(useVoiceAutoSendSettings)
        expect(first.result.current.enabled).toBe(false)
        expect(first.result.current.delay).toBe(3)
        act(() => first.result.current.update({ enabled: true, delay: 5 }))
        first.unmount()
        const next = renderHook(useVoiceAutoSendSettings)
        expect(next.result.current).toMatchObject({ enabled: true, delay: 5 })
    })

    it('cancels immediately when disabled and never retries a failed send automatically', async () => {
        settings(2)
        const send = vi.fn(async () => { throw new Error('Offline') })
        renderHook(() => useVoiceAutoSend({ silenceSince: 10000, ready: true, draft: 'Draft', send }))
        act(() => settings(2, false))
        await act(async () => vi.advanceTimersByTimeAsync(3000))
        expect(send).not.toHaveBeenCalled()
        act(() => settings(2, true))
        await act(async () => vi.advanceTimersByTimeAsync(10000))
        expect(send).toHaveBeenCalledOnce()
    })

    it('does not send while hidden or with an empty draft', async () => {
        settings(2)
        const send = vi.fn(async () => {})
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        renderHook(() => useVoiceAutoSend({ silenceSince: 10000, ready: true, draft: 'Draft', send }))
        renderHook(() => useVoiceAutoSend({ silenceSince: 10000, ready: true, draft: '', send }))
        await act(async () => vi.advanceTimersByTimeAsync(3000))
        expect(send).not.toHaveBeenCalled()
    })
})
