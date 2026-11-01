import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'
import { openOmniTransport } from '@/lib/omniTransport'
import { useOmniVoice } from './useOmniVoice'

vi.mock('@/lib/pcm16Worklet', () => ({ addPcm16Worklet: vi.fn(), stopPcm16Worklet: (node: AudioWorkletNode) => { node.port.onmessage = null; node.disconnect() } }))
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

describe('Omni tool acknowledgements', () => {
    it('waits for the committed response and acknowledges each matching call only once', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        const call = { type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'call-1', response_id: 'r1', arguments: '{"text":"Draft"}' }
        act(() => emit(call))
        expect(result.current.draft).toBe('Draft')
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ type: 'function_call_output' }) }))
        const done = { type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ type: 'function_call', call_id: 'call-1' }] } }
        act(() => emit(done))
        act(() => emit(call))
        act(() => emit(done))
        const outputs = vi.mocked(transport.send).mock.calls.filter(([event]: [{ type: string }]) => event.type === 'conversation.item.create')
        expect(outputs).toEqual([[{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ saved: true, draft: 'Draft', instruction: '下一轮以此完整草稿为底稿，融合新话后返回全文，不能只返回最后一句。' }) } }]])
    })

    it('does not acknowledge missing ids, uncommitted calls, or cancelled responses', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Draft"}' }))
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'call-1', response_id: 'r1', arguments: '{"text":"Draft"}' }))
        act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled', output: [{ type: 'function_call', call_id: 'call-1' }] } }))
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ type: 'function_call_output' }) }))
    })

    it('uses ASR text when a complete response omits update_draft', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'speech-1' }))
        act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
        act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech-1', transcript: '我没跟你说这个' }))
        act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } }))
        expect(result.current.draft).toBe('我没跟你说这个')
        expect(result.current.draftIssue).toBeNull()
    })
})


it('does not rerender the session for repeated unchanged state notifications', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const render = vi.fn(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'session-1' }))
    const { result } = renderHook(render)
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'session.updated' }))
    const count = render.mock.calls.length
    for (let i = 0; i < 20; i++) act(() => emit({ type: 'session.updated' }))
    expect(render.mock.calls.length - count).toBeLessThanOrEqual(1)
})


it('keeps the full canonical draft in model context while accepting holistic rewrites', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    const first = 'Preserve mobile behavior. ' + 'Detailed requirement. '.repeat(150)
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'first', arguments: JSON.stringify({ text: first }) }))
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining(JSON.stringify(first.trim())) } })
    const rewritten = 'Reorganized complete draft including the earlier requirement and the new condition.'
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'second', arguments: JSON.stringify({ text: rewritten }) }))
    expect(result.current.draft).toBe(rewritten)
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining(JSON.stringify(rewritten)) } })
    act(() => result.current.clearDraft())
    expect(vi.mocked(transport.send).mock.calls.some(([event]: [{ type: string; session?: { instructions?: string } }]) => event.session?.instructions?.includes('【当前完整草稿】\n""'))).toBe(true)
})


it('automatically delivers the complete draft once after the configured speech pause', async () => {
    vi.useFakeTimers()
    localStorage.setItem('hapi.voiceAutoSend', JSON.stringify({ enabled: true, delay: 2 }))
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }),
        reportVoiceEvent: async () => {},
        resumeSession: vi.fn(async () => 'session-1'),
        sendMessage: vi.fn(async () => ({ seq: 1 })),
        getOmniVoiceReply: async () => ({ status: 'done', reply: 'Done' })
    }
    const { result, unmount } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'c1', response_id: 'r1', arguments: JSON.stringify({ text: 'Full first sentence. Full second sentence.' }) }))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(api.sendMessage).not.toHaveBeenCalled()
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } }))
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('session-1', expect.stringContaining('Full first sentence. Full second sentence.'), expect.any(String))
    expect(result.current.draft).toBe('')
    unmount()
    localStorage.removeItem('hapi.voiceAutoSend')
})
