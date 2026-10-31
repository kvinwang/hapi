import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'
import { useOmniVoice } from './useOmniVoice'

vi.mock('@/lib/pcm16Worklet', () => ({ addPcm16Worklet: vi.fn() }))
vi.mock('@/lib/omniTransport', () => ({ openOmniTransport: () => ({ send: vi.fn(), close: vi.fn() }) }))
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
    createGain = () => ({ connect: vi.fn() })
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
    vi.mocked(addPcm16Worklet).mockResolvedValue({ port: { onmessage: null }, disconnect: vi.fn() } as unknown as AudioWorkletNode)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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
