import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'
import { openOmniTransport } from '@/lib/omniTransport'
import { useOmniVoice } from './useOmniVoice'

vi.mock('@/lib/pcm16Worklet', () => ({ addPcm16Worklet: vi.fn() }))
vi.mock('@/lib/omniTransport', () => ({ openOmniTransport: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })) }))
vi.mock('@/components/VoiceOrb', () => ({
    VOICE_ENVIRONMENTS: { quiet: 0.5 }, getVoiceEnvironment: () => 'quiet', isVoiceReadRepliesEnabled: () => true
}))

const events: string[] = []
const audioSession = {
    value: 'auto',
    get type() { return this.value },
    set type(value: string) { this.value = value; events.push(value) }
}
const track = { stop: vi.fn(() => events.push('track stopped')), readyState: 'live', muted: false }
const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
const getUserMedia = vi.fn<() => Promise<MediaStream>>()

class TestAudioContext {
    state = 'running'
    destination = {}
    constructor() { events.push('audio context') }
    resume = async () => {}
    close = async () => { this.state = 'closed' }
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn() })
    createAnalyser = () => ({ connect: vi.fn(), fftSize: 0 })
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
}

beforeEach(() => {
    events.length = 0
    audioSession.value = 'auto'
    vi.clearAllMocks()
    vi.stubGlobal('AudioContext', TestAudioContext)
    vi.stubGlobal('navigator', { audioSession, mediaDevices: { getUserMedia } })
    getUserMedia.mockImplementation(async () => { events.push('capture'); return stream })
    vi.mocked(addPcm16Worklet).mockImplementation(async () => ({ port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioWorkletNode))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function renderVoice() {
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }),
        reportVoiceEvent: async () => {}
    } as unknown as ApiClient
    return renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'session-1' }))
}

describe('Omni audio session lifecycle', () => {
    it('selects capture before starting audio and restores playback after stopping the mic', async () => {
        const { result, unmount } = renderVoice()
        act(() => result.current.toggle())
        await waitFor(() => expect(addPcm16Worklet).toHaveBeenCalledOnce())
        expect(events.indexOf('play-and-record')).toBeLessThan(events.indexOf('audio context'))
        expect(events.indexOf('play-and-record')).toBeLessThan(events.indexOf('capture'))
        act(() => result.current.toggle())
        expect(result.current.micOn).toBe(false)
        expect(events.indexOf('track stopped')).toBeLessThan(events.indexOf('playback'))
        expect(audioSession.type).toBe('playback')
        act(() => result.current.toggle())
        await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
        expect(audioSession.type).toBe('play-and-record')
        unmount()
        expect(audioSession.type).toBe('auto')
    })

    it('stops a late microphone permission result without restarting capture or the audio route', async () => {
        let grant!: (stream: MediaStream) => void
        getUserMedia.mockImplementation(() => new Promise((resolve) => { grant = resolve }))
        const { result } = renderVoice()
        act(() => result.current.toggle())
        await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce())
        act(() => result.current.toggle())
        await act(async () => grant(stream))
        expect(track.stop).toHaveBeenCalledOnce()
        expect(addPcm16Worklet).not.toHaveBeenCalled()
        expect(audioSession.type).toBe('playback')
    })

    it('releases the microphone and restores the previous category if worklet setup fails', async () => {
        audioSession.value = 'ambient'
        vi.mocked(addPcm16Worklet).mockRejectedValue(new Error('Worklet failed'))
        const { result } = renderVoice()
        act(() => result.current.toggle())
        await waitFor(() => expect(result.current.state).toBe('error'))
        expect(track.stop).toHaveBeenCalledOnce()
        expect(audioSession.type).toBe('ambient')
    })

    it('continues to capture in browsers without the Audio Session API', async () => {
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
        const { result } = renderVoice()
        act(() => result.current.toggle())
        await waitFor(() => expect(addPcm16Worklet).toHaveBeenCalledOnce())
        expect(result.current.micOn).toBe(true)
    })
})


describe('Omni interruption recovery', () => {
    it('rebuilds a running context with no frames and connects capture to a muted output', async () => {
        vi.useFakeTimers()
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        expect(events.filter((event) => event === 'audio context')).toHaveLength(1)
        const first = await vi.mocked(addPcm16Worklet).mock.results[0].value
        expect(first.connect).toHaveBeenCalledOnce()
        expect(vi.mocked(first.connect).mock.calls[0][0]).toMatchObject({ gain: { value: 0 } })
        await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
        expect(events.filter((event) => event === 'audio context')).toHaveLength(2)
        expect(getUserMedia).toHaveBeenCalledTimes(2)
        expect(result.current.micOn).toBe(true)
        expect(first.port.onmessage).toBeNull()
        const replacement = await vi.mocked(addPcm16Worklet).mock.results[1].value
        act(() => vi.mocked(openOmniTransport).mock.calls[0][0].onEvent({ type: 'session.updated' }))
        act(() => replacement.port.onmessage?.(new MessageEvent('message', { data: new Int16Array(800).buffer })))
        expect(vi.mocked(openOmniTransport).mock.results[0].value.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'input_audio_buffer.append' }))
    })

    it('reconnects on unlock, preserves the draft and ignores events from the old connection', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const initial = vi.mocked(openOmniTransport).mock.calls[0][0]
        act(() => initial.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: 'Keep this draft' }) }))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        expect(openOmniTransport).toHaveBeenCalledTimes(2)
        expect(getUserMedia).toHaveBeenCalledTimes(2)
        expect(events.filter((event) => event === 'audio context')).toHaveLength(2)
        const next = vi.mocked(openOmniTransport).mock.results[1].value
        expect(next.send).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ instructions: expect.stringContaining('Keep this draft') }) }))
        act(() => initial.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: 'Stale draft' }) }))
        expect(result.current.draft).toBe('Keep this draft')
    })

    it('does not restart a microphone the user turned off while the page was hidden', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        act(() => result.current.toggle())
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        expect(getUserMedia).toHaveBeenCalledOnce()
        expect(result.current.micOn).toBe(false)
    })

    it('shows the microphone as off when iOS will not resume audio without a gesture', async () => {
        vi.useFakeTimers()
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        vi.stubGlobal('AudioContext', class extends TestAudioContext {
            state = 'suspended'
            resume = () => new Promise<void>(() => {})
        })
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(result.current.micOn).toBe(false)
        expect(audioSession.type).toBe('playback')
        expect(getUserMedia).toHaveBeenCalledOnce()
    })

})


describe('Omni empty recognition feedback', () => {
    it('keeps an explicit reason when speech produces no draft, until dismissed', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'input_audio_buffer.speech_started' }))
        act(() => emit({ type: 'input_audio_buffer.speech_stopped' }))
        act(() => emit({ type: 'response.done', response: { status: 'completed' } }))
        expect(result.current.drafting).toBe(false)
        expect(result.current.draft).toBe('')
        expect(result.current.draftIssue).toEqual({ reason: 'noDraft', detail: undefined })
        act(() => result.current.clearDraft())
        expect(result.current.draftIssue).toBeNull()
    })

    it('preserves the existing draft and displays the service failure without replacing it on response.done', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: 'Existing draft' }) }))
        act(() => emit({ type: 'input_audio_buffer.speech_started' }))
        act(() => emit({ type: 'conversation.item.input_audio_transcription.failed', error: { message: 'Audio transcription unavailable' } }))
        act(() => emit({ type: 'response.done' }))
        expect(result.current.draft).toBe('Existing draft')
        expect(result.current.draftIssue).toEqual({ reason: 'service', detail: 'Audio transcription unavailable' })
    })

    it('allows an intentional empty draft without showing a recognition failure', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'input_audio_buffer.speech_started' }))
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":""}' }))
        act(() => emit({ type: 'response.done' }))
        expect(result.current.draftIssue).toBeNull()
    })
})
