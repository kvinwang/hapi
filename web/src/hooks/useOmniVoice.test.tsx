import { setVoiceSensitivity } from '@/lib/voiceSensitivity'
import { createThreadVoiceApi, threadVoiceKey } from '@/lib/threadVoiceApi'
import { registerPlayback } from '@/lib/mediaPlayback'
import { clearMessageWindow, appendOptimisticMessage } from '@/lib/message-window-store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'
import { openOmniTransport } from '@/lib/omniTransport'
import { useOmniVoice } from './useOmniVoice'

vi.mock('@/lib/pcm16Worklet', () => ({ addPcm16Worklet: vi.fn(), stopPcm16Worklet: (node: AudioWorkletNode) => { node.port.onmessage = null; node.disconnect() } }))
vi.mock('@/lib/omniTransport', () => ({ openOmniTransport: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })) }))
vi.mock('@/components/VoiceOrb', () => ({
    VOICE_ENVIRONMENTS: { quiet: 50 }, getVoiceEnvironment: () => 'quiet', isVoiceReadRepliesEnabled: () => true
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

class TestAudioContext extends EventTarget {
    state = 'running'
    destination = {}
    constructor() { super(); events.push('audio context') }
    resume = async () => {}
    close = async () => { this.state = 'closed' }
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn() })
    createAnalyser = () => ({ connect: vi.fn(), fftSize: 0 })
    createDynamicsCompressor = () => ({ connect: vi.fn(), threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} })
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
    it('keeps the automatic audio category while toggling microphone capture', async () => {
        const { result, unmount } = renderVoice()
        act(() => result.current.toggle())
        await waitFor(() => expect(addPcm16Worklet).toHaveBeenCalledOnce())
        expect(events.indexOf('auto')).toBeLessThan(events.indexOf('audio context'))
        expect(events.indexOf('auto')).toBeLessThan(events.indexOf('capture'))
        act(() => result.current.toggle())
        expect(result.current.micOn).toBe(false)
        expect(events).not.toContain('playback')
        expect(audioSession.type).toBe('auto')
        act(() => result.current.toggle())
        await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
        expect(audioSession.type).toBe('auto')
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
        expect(audioSession.type).toBe('auto')
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
    it('reuses the unlocked context on the first stalled-capture recovery', async () => {
        vi.useFakeTimers()
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        expect(events.filter((event) => event === 'audio context')).toHaveLength(1)
        const first = await vi.mocked(addPcm16Worklet).mock.results[0].value
        expect(first.connect).toHaveBeenCalledOnce()
        expect(vi.mocked(first.connect).mock.calls[0][0]).toMatchObject({ gain: { value: 0 } })
        await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
        expect(events.filter((event) => event === 'audio context')).toHaveLength(1)
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
        expect(events.filter((event) => event === 'audio context')).toHaveLength(1)
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

    it('automatically rebuilds after a suspended context fails to resume', async () => {
        vi.useFakeTimers()
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const context = vi.mocked(addPcm16Worklet).mock.calls[0][0]
        Object.defineProperty(context, 'state', { configurable: true, value: 'suspended' })
        vi.spyOn(context, 'resume').mockImplementation(() => new Promise<void>(() => {}))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        act(() => document.dispatchEvent(new Event('visibilitychange')))
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
        await act(async () => document.dispatchEvent(new Event('visibilitychange')))
        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(result.current.micOn).toBe(false)
        expect(audioSession.type).toBe('auto')
        expect(getUserMedia).toHaveBeenCalledOnce()
        expect(result.current.micRecovering).toBe(true)
        await act(async () => vi.advanceTimersByTimeAsync(4000))
        expect(getUserMedia).toHaveBeenCalledTimes(2)
        expect(events.filter((event) => event === 'audio context')).toHaveLength(2)
        expect(result.current.micOn).toBe(true)
        const node = await vi.mocked(addPcm16Worklet).mock.results.at(-1)!.value
        act(() => {
            for (let i = 0; i < 20; i++) node.port.onmessage?.(new MessageEvent('message', { data: new Int16Array(800).buffer }))
        })
        expect(result.current.micRecovering).toBe(false)
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
        expect(outputs).toEqual([[{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ saved: true }) } }]])
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

    it('retains ASR text for confirmation when a complete response omits update_draft', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'speech-1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'speech-1' }))
        act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
        act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech-1', transcript: '我没跟你说这个' }))
        act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } }))
        expect(result.current.draft).toBe('')
        expect(result.current.deferred).toEqual([{ text: '我没跟你说这个', reason: '', status: 'unprocessed' }])
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
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining(first.trim()) } })
    const rewritten = 'Reorganized complete draft including the earlier requirement and the new condition.'
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'second', arguments: JSON.stringify({ text: rewritten }) }))
    expect(result.current.draft).toBe(rewritten)
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining(rewritten) } })
    act(() => result.current.clearDraft())
    expect(vi.mocked(transport.send).mock.calls.some(([event]: [{ type: string; session?: { instructions?: string } }]) => event.session?.instructions?.includes('【当前完整草稿】\n（空）'))).toBe(true)
})


it('waits the configured delay after the complete draft is ready before delivering once', async () => {
    vi.useFakeTimers()
    localStorage.setItem('hapi.voiceAutoSend', JSON.stringify({ enabled: true, delay: 2 }))
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }),
        reportVoiceEvent: async () => {},
        resumeSession: vi.fn(async () => 'session-1'),
        sendMessage: vi.fn(async () => ({ seq: 1 })),
        getOmniVoiceReply: vi.fn(async () => ({ status: 'done', reply: 'Done' }))
    }
    const { result, unmount } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'c1', response_id: 'r1', arguments: JSON.stringify({ text: 'Full first sentence. Full second sentence.' }) }))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(api.sendMessage).not.toHaveBeenCalled()
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [] } }))
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(api.sendMessage).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1999))
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('session-1', expect.stringContaining('Full first sentence. Full second sentence.'), expect.any(String))
    expect(result.current.draft).toBe('')
    expect(api.getOmniVoiceReply).not.toHaveBeenCalled()
    unmount()
    localStorage.removeItem('hapi.voiceAutoSend')
})

it('shows recognized text immediately without requiring a completed response or another utterance', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'speech' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'speech' }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech', transcript: 'The entire current sentence' }))
    expect(result.current.transcription).toBe('The entire current sentence')
    expect(result.current.draft).toBe('')
    act(() => emit({ type: 'response.created', response: { id: 'response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'response', call_id: 'call', arguments: '{"text":"The refined current sentence."}' }))
    expect(result.current.transcription).toBe('')
    expect(result.current.draft).toBe('The refined current sentence.')
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech', transcript: 'The entire current sentence' }))
    expect(result.current.transcription).toBe('')
})

it('clears on a standalone cancel command and ignores the late model draft for that command', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'first', arguments: '{"text":"Existing full draft"}' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'cancel' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'cancel' }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'cancel', transcript: '算了，不发了。' }))
    expect(result.current.draft).toBe('')
    act(() => emit({ type: 'response.created', response: { id: 'cancel-response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'cancel-response', call_id: 'cancel-call', arguments: '{"text":"Existing full draft. 算了不发了"}' }))
    expect(result.current.draft).toBe('')
})

it.each(['发送。', 'Send.'])('sends the preceding draft once for standalone %s without including the command', async (transcript) => {
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {},
        resumeSession: async () => 'session-1', sendMessage: vi.fn(async () => ({ seq: 1 })),
        getOmniVoiceReply: vi.fn(async () => ({ status: 'done', reply: 'Done' }))
    }
    const { result } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'first', arguments: '{"text":"Existing full draft"}' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'send' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'send' }))
    const command = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'send', transcript }
    await act(async () => emit(command))
    await act(async () => emit(command))
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('session-1', '[语音·小精灵整理，可能有同音错字]\nExisting full draft', expect.any(String))
})




it('keeps summarizing the new utterance when an older response finishes', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's1' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's2' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's2' }))
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } }))
    expect(result.current.drafting).toBe(true)
    expect(result.current.draftIssue).toBeNull()
})

it('sends a terminal draft only to the terminal and honors the execute checkbox', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Terminal', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {}, resumeSession: vi.fn(), sendMessage: vi.fn() }
    const writeTerminal = vi.fn(() => true)
    const { result } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 's1', target: 'terminal', writeTerminal }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const draft = (id: string, text: string) => act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: id, arguments: JSON.stringify({ text }) }))
    draft('a', 'ls -lah')
    await act(async () => result.current.sendDraft())
    expect(writeTerminal).toHaveBeenLastCalledWith('ls -lah')
    localStorage.setItem('hapi.voiceTerminalExecute', '1')
    draft('b', 'pwd')
    await act(async () => result.current.sendDraft())
    expect(writeTerminal).toHaveBeenLastCalledWith('pwd\r')
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.resumeSession).not.toHaveBeenCalled()
    localStorage.removeItem('hapi.voiceTerminalExecute')
})

it('preserves a command draft when the terminal is disconnected and never uses raw ASR as a command', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Terminal', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 's1', target: 'terminal', writeTerminal: () => false }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'c', arguments: '{"text":"ls"}' }))
    await act(async () => result.current.sendDraft())
    expect(result.current.draft).toBe('ls')
    expect(result.current.caption?.text).toBe('terminalUnavailable')
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's' }))
    act(() => emit({ type: 'response.created', response: { id: 'r' } }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's', transcript: 'Show all files' }))
    act(() => emit({ type: 'response.done', response: { id: 'r', status: 'completed' } }))
    expect(result.current.draft).toBe('ls')
    expect(result.current.draftIssue).not.toBeNull()
})

it('keeps chat and terminal drafts separate while switching the voice target', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, rerender } = renderHook((target: 'chat' | 'terminal') => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 's1', target, writeTerminal: () => true }), { initialProps: 'chat' as 'chat' | 'terminal' })
    await act(async () => result.current.toggle())
    const first = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => first({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'chat', arguments: '{"text":"Keep this AI message"}' }))
    await act(async () => rerender('terminal'))
    expect(result.current.draft).toBe('')
    const second = vi.mocked(openOmniTransport).mock.calls[1][0].onEvent
    act(() => second({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'terminal', arguments: '{"text":"ls -lah"}' }))
    await act(async () => rerender('chat'))
    expect(result.current.draft).toBe('Keep this AI message')
    await act(async () => rerender('terminal'))
    expect(result.current.draft).toBe('ls -lah')
})

it('closes a summarizing draft after mic-off and clear, ignoring late speech and model results', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's1' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    expect(result.current.drafting).toBe(true)
    act(() => result.current.toggle())
    act(() => result.current.clearDraft())
    expect(result.current.micOn).toBe(false)
    expect(result.current.drafting).toBe(false)
    expect(result.current.draft).toBe('')
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'late' }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's1', transcript: 'Old words' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'c1', response_id: 'r1', arguments: '{"text":"Late old draft"}' }))
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed' } }))
    expect(result.current.drafting).toBe(false)
    expect(result.current.draft).toBe('')
    expect(result.current.transcription).toBe('')
    expect(result.current.draftIssue).toBeNull()
    await act(async () => result.current.toggle())
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's2' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's2' }))
    act(() => emit({ type: 'response.created', response: { id: 'r2' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'c2', response_id: 'r2', arguments: '{"text":"New draft"}' }))
    expect(result.current.draft).toBe('New draft')
})

it('handles standalone spoken Ctrl+C as a terminal key, preserving the command draft', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Terminal', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {}, sendMessage: vi.fn(), interruptSession: vi.fn() }
    const writeTerminal = vi.fn(() => true)
    const { result } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 's1', target: 'terminal', writeTerminal }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'draft', arguments: '{"text":"tail -f app.log"}' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'key' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'key' }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'key', transcript: 'Ctrl+C' }))
    expect(writeTerminal).toHaveBeenCalledExactlyOnceWith('\x03')
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.interruptSession).not.toHaveBeenCalled()
    expect(result.current.draft).toBe('tail -f app.log')
    act(() => emit({ type: 'response.created', response: { id: 'key-response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'key-call', response_id: 'key-response', arguments: '{"text":"Ctrl+C"}' }))
    expect(result.current.draft).toBe('tail -f app.log')
})


describe('voice communication intent', () => {
    it('keeps side conversation visible and prevents late ASR from adding it to the draft', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'session.updated' }))
        act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
        act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's1' }))
        act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
        const deferred = [{ text: 'Please pass the salt', reason: 'Addressed to someone at the table', status: 'ignored' }]
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'r1', arguments: JSON.stringify({ text: 'Fix the terminal', deferred }) }))
        act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed' } }))
        act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's1', transcript: 'Please pass the salt' }))
        expect(result.current.draft).toBe('Fix the terminal')
        expect(result.current.deferred).toEqual(deferred)
        expect(result.current.draftIssue).toBeNull()
        act(() => result.current.resolveSpeech(0, true))
        expect(result.current.deferred[0].status).toBe('unprocessed')
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining('Please pass the salt') })] }) }))
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: 'Fix the terminal. Please pass the salt.', deferred: [] }) }))
        expect(result.current.deferred).toEqual([])
        expect(result.current.draft).toBe('Fix the terminal. Please pass the salt.')
    })

    it('retains uncertain speech across new speech and clears it explicitly', async () => {
        const { result } = renderVoice()
        await act(async () => result.current.toggle())
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        act(() => emit({ type: 'session.updated' }))
        const deferred = [{ text: 'Not talking to you', reason: 'Recipient unclear', status: 'unprocessed' }]
        act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: '', deferred }) }))
        act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's2' }))
        expect(result.current.deferred).toEqual(deferred)
        act(() => result.current.clearDraft())
        expect(result.current.deferred).toEqual([])
    })
})

it('pauses auto-send for uncertain speech even when a valid draft is present', async () => {
    vi.useFakeTimers()
    localStorage.setItem('hapi.voiceAutoSend', JSON.stringify({ enabled: true, delay: 2 }))
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }),
        reportVoiceEvent: async () => {},
        resumeSession: vi.fn(async () => 'session-1'),
        sendMessage: vi.fn(async () => ({ seq: 1 }))
    }
    const { result, unmount } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's1' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'r1', arguments: JSON.stringify({ text: 'Fix terminal', deferred: [{ text: 'Not you', reason: 'Recipient unclear', status: 'unprocessed' }] }) }))
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed' } }))
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(result.current.deferred).toHaveLength(1)
    unmount()
    localStorage.removeItem('hapi.voiceAutoSend')
})


it('refreshes model context when the active conversation receives a new message', async () => {
    vi.useFakeTimers()
    clearMessageWindow('session-1')
    const { result, unmount } = renderVoice()
    await act(async () => result.current.toggle())
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    act(() => appendOptimisticMessage('session-1', { id: 'context-test', localId: null, seq: 42, createdAt: Date.now(), content: { role: 'user', content: { type: 'text', text: 'The previous message was sent by mistake.' } } }))
    await act(async () => vi.advanceTimersByTimeAsync(600))
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining('The previous message was sent by mistake.') } })
    unmount()
    clearMessageWindow('session-1')
})

it('automatically retries a missing draft once, then handles spoken inclusion without a confirmation loop', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: '现在测的不是真实的模型加载吗？', deferred: [] }) }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's1' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's1' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's1', transcript: '解释一下测的是啥。' }))
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed' } }))
    expect(result.current.deferred[0]).toMatchObject({ text: '解释一下测的是啥。', status: 'unprocessed' })
    expect(transport.send).toHaveBeenCalledWith({ type: 'response.create' })
    act(() => emit({ type: 'response.created', response: { id: 'retry' } }))
    act(() => emit({ type: 'response.done', response: { id: 'retry', status: 'completed' } }))
    expect(result.current.draftIssue?.reason).toBe('noDraft')
    const requests = () => vi.mocked(transport.send).mock.calls.filter(([event]: [{ type: string }]) => event.type === 'response.create').length
    expect(requests()).toBe(1)
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 's2' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 's2' }))
    act(() => emit({ type: 'response.created', response: { id: 'r2' } }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 's2', transcript: '我让你加入草稿。' }))
    expect(requests()).toBe(1)
    act(() => emit({ type: 'response.done', response: { id: 'r2', status: 'completed' } }))
    expect(requests()).toBe(2)
    expect(result.current.deferred).toHaveLength(1)
    act(() => emit({ type: 'response.created', response: { id: 'retry2' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'retry2', arguments: JSON.stringify({ text: '现在测的不是真实的模型加载吗？解释一下测的是啥。', deferred: [] }) }))
    act(() => emit({ type: 'response.done', response: { id: 'retry2', status: 'completed' } }))
    expect(result.current.draft).toBe('现在测的不是真实的模型加载吗？解释一下测的是啥。')
    expect(result.current.deferred).toEqual([])
    expect(result.current.draftIssue).toBeNull()
})

it('temporarily pauses auto-send on spoken wait and resumes for the next utterance', async () => {
    vi.useFakeTimers()
    localStorage.setItem('hapi.voiceAutoSend', JSON.stringify({ enabled: true, delay: 2 }))
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }),
        reportVoiceEvent: async () => {}, resumeSession: vi.fn(async () => 'session-1'), sendMessage: vi.fn(async () => ({ seq: 1 }))
    }
    const { result, unmount } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ tool_choice: 'required', modalities: ['text'] }) }))
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: 'Keep this draft', deferred: [] }) }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'wait' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'wait' }))
    act(() => emit({ type: 'response.created', response: { id: 'wait-response' } }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'wait', transcript: '等等。' }))
    act(() => emit({ type: 'response.done', response: { id: 'wait-response', status: 'completed' } }))
    await act(async () => vi.advanceTimersByTimeAsync(2500))
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(result.current.draft).toBe('Keep this draft')
    expect(result.current.autoSendSeconds).toBeNull()
    expect(JSON.parse(localStorage.getItem('hapi.voiceAutoSend')!).enabled).toBe(true)
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'next' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'next' }))
    act(() => emit({ type: 'response.created', response: { id: 'next-response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'next-response', arguments: JSON.stringify({ text: 'Keep this draft with the correction', deferred: [] }) }))
    act(() => emit({ type: 'response.done', response: { id: 'next-response', status: 'completed' } }))
    expect(result.current.autoSendSeconds).toBe(2)
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(api.sendMessage).toHaveBeenCalledOnce()
    unmount()
    localStorage.removeItem('hapi.voiceAutoSend')
})


it('keeps microphone frames flowing while readback ducks for speech', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    const duck = vi.fn()
    const playback = registerPlayback(duck)
    const node = await vi.mocked(addPcm16Worklet).mock.results[0].value
    act(() => {
        for (let i = 0; i < 4; i++) node.port.onmessage?.(new MessageEvent('message', { data: new Int16Array(800).fill(2000).buffer }))
    })
    expect(duck).toHaveBeenLastCalledWith(true)
    expect(track.stop).not.toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(result.current.micOn).toBe(true)
    expect(audioSession.type).toBe('auto')
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'input_audio_buffer.append' }))
    playback.release()
    expect(getUserMedia).toHaveBeenCalledOnce()
})

it('does not reopen a manually disabled mic when playback ends', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const playback = registerPlayback(vi.fn())
    act(() => result.current.toggle())
    playback.release()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(result.current.micOn).toBe(false)
})

it('ignores quiet playback echoes without restoring them as draft candidates', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const playback = registerPlayback(vi.fn())
    playback.text('The microphone recovery tests all passed.')
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'echo' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'echo' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'echo', transcript: 'The microphone recovery tests all passed.' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'r1', arguments: '{"text":"Echo must not become a draft"}' }))
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed' } }))
    expect(result.current.draft).toBe('')
    expect(result.current.deferred).toEqual([])
    playback.release()
})

it('does not restart capture while the worklet is still opening', async () => {
    vi.useFakeTimers()
    let finish!: (node: AudioWorkletNode) => void
    vi.mocked(addPcm16Worklet).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(events.filter(event => event === 'audio context')).toHaveLength(1)
    await act(async () => finish({ port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioWorkletNode))
    expect(result.current.micOn).toBe(true)
})

it('backs off repeated no-frame recoveries instead of reopening every few seconds indefinitely', async () => {
    vi.useFakeTimers()
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    await act(async () => vi.advanceTimersByTimeAsync(30000))
    expect(getUserMedia.mock.calls.length).toBeLessThanOrEqual(5)
    expect(events.filter(event => event === 'audio context').length).toBeLessThanOrEqual(3)
    expect(result.current.micRecovering).toBe(true)
    const calls = getUserMedia.mock.calls.length
    act(() => result.current.toggle())
    await act(async () => vi.advanceTimersByTimeAsync(60000))
    expect(getUserMedia).toHaveBeenCalledTimes(calls)
    expect(result.current.micOn).toBe(false)
})

it('ignores an obsolete recovery failure after the user has reopened capture', async () => {
    vi.useFakeTimers()
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    let fail!: (error: Error) => void
    getUserMedia.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    act(() => result.current.toggle())
    await act(async () => result.current.toggle())
    expect(result.current.micOn).toBe(true)
    const stops = track.stop.mock.calls.length
    await act(async () => fail(new Error('Obsolete capture failure')))
    expect(result.current.micOn).toBe(true)
    expect(track.stop).toHaveBeenCalledTimes(stops)
})

it('reopens normally after the three-minute idle shutdown', async () => {
    vi.useFakeTimers()
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const node = await vi.mocked(addPcm16Worklet).mock.results[0].value
    const frames = setInterval(() => node.port.onmessage?.(new MessageEvent('message', { data: new Int16Array(800).buffer })), 50)
    await act(async () => vi.advanceTimersByTimeAsync(182000))
    clearInterval(frames)
    expect(result.current.micOn).toBe(false)
    expect(getUserMedia).toHaveBeenCalledOnce()
    await act(async () => result.current.toggle())
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.micOn).toBe(true)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
})

it('keeps capture alive across sessions, restores their drafts, and ignores stale model output', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, rerender } = renderHook(({ sessionId }) => useOmniVoice({ api, baseUrl: '', token: '', sessionId }), { initialProps: { sessionId: 'first' } })
    await act(async () => result.current.toggle())
    const first = vi.mocked(openOmniTransport).mock.calls[0][0]
    act(() => first.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"First draft"}' }))
    await act(async () => rerender({ sessionId: 'second' }))
    expect(track.stop).not.toHaveBeenCalled()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(result.current.micOn).toBe(true)
    expect(result.current.draft).toBe('')
    act(() => first.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Stale output"}' }))
    expect(result.current.draft).toBe('')
    const second = vi.mocked(openOmniTransport).mock.calls[1][0]
    act(() => second.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Second draft"}' }))
    await act(async () => rerender({ sessionId: 'first' }))
    expect(result.current.draft).toBe('First draft')
    expect(getUserMedia).toHaveBeenCalledOnce()
})

it.each(['asr', 'tool'])('applies a UI command once when %s arrives first without changing the draft', async (firstEvent) => {
    const onUiControl = vi.fn(() => ({ ok: true }))
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'first', onUiControl }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Keep me"}' }))
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'command' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'command' }))
    act(() => emit({ type: 'response.created', response: { id: 'r1' } }))
    const asr = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'command', transcript: '关闭草稿' }
    const tool = { type: 'response.function_call_arguments.done', name: 'control_ui', call_id: 'c1', response_id: 'r1', arguments: '{"command":"draft panel hide"}' }
    act(() => { emit(firstEvent === 'asr' ? asr : tool); emit(firstEvent === 'asr' ? tool : asr) })
    act(() => emit({ type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ type: 'function_call', call_id: 'c1' }] } }))
    expect(onUiControl).toHaveBeenCalledExactlyOnceWith({ action: 'draft_panel', open: false })
    expect(result.current.draft).toBe('Keep me')
    expect(result.current.deferred).toEqual([])
})

it('resets all voice drafts, candidates, and model history without stopping capture or importing old context', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: 'Old unrelated conversation', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, rerender } = renderHook(({ sessionId }) => useOmniVoice({ api, baseUrl: '', token: '', sessionId }), { initialProps: { sessionId: 'first' } })
    await act(async () => result.current.toggle())
    const first = vi.mocked(openOmniTransport).mock.calls[0][0]
    act(() => first.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"First old draft"}' }))
    await act(async () => rerender({ sessionId: 'second' }))
    const second = vi.mocked(openOmniTransport).mock.calls[1][0]
    act(() => second.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: JSON.stringify({ text: 'Second old draft', deferred: [{ text: 'Unrelated words', reason: '', status: 'ignored' }] }) }))
    await act(async () => result.current.resetHistory())
    expect(result.current.draft).toBe('')
    expect(result.current.deferred).toEqual([])
    expect(result.current.transcription).toBe('')
    expect(result.current.draftIssue).toBeNull()
    expect(result.current.autoSendSeconds).toBeNull()
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(track.stop).not.toHaveBeenCalled()
    act(() => second.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Late old output"}' }))
    expect(result.current.draft).toBe('')
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value
    const config = vi.mocked(transport.send).mock.calls.find(([event]: [{ type: string }]) => event.type === 'session.update')![0]
    expect(JSON.stringify(config)).not.toContain('Old unrelated conversation')
    expect(JSON.stringify(config)).not.toContain('Second old draft')
    expect(JSON.stringify(config)).not.toContain('Unrelated words')
    await act(async () => rerender({ sessionId: 'first' }))
    expect(result.current.draft).toBe('')
    const fresh = vi.mocked(openOmniTransport).mock.calls.at(-1)![0]
    act(() => fresh.onEvent({ type: 'input_audio_buffer.speech_started', item_id: 'new' }))
    act(() => fresh.onEvent({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Fresh request"}' }))
    expect(result.current.draft).toBe('Fresh request')
})

it('rolls back a quiet readback echo when its transcription arrives after the draft tool', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Keep the real request"}' }))
    const playback = registerPlayback(vi.fn())
    playback.text('The microphone recovery tests all passed.')
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'echo-late' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'echo-late' }))
    act(() => emit({ type: 'response.created', response: { id: 'echo-response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'echo-response', arguments: '{"text":"Keep the real request. The microphone recovery tests all passed."}' }))
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'echo-late', transcript: 'The microphone recovery tests all passed.' }))
    expect(result.current.draft).toBe('Keep the real request')
    playback.release()
})

it('does not auto-send a playback-era draft before its echo transcription is checked', async () => {
    vi.useFakeTimers()
    localStorage.setItem('hapi.voiceAutoSend', JSON.stringify({ enabled: true, delay: 2 }))
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {}, resumeSession: async () => 'session-1', sendMessage: vi.fn(async () => ({ seq: 1 })) }
    const { result, unmount } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    const playback = registerPlayback(vi.fn())
    playback.text('The microphone recovery tests all passed.')
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'echo-send' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'echo-send' }))
    act(() => emit({ type: 'response.created', response: { id: 'echo-r' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', response_id: 'echo-r', arguments: '{"text":"The microphone recovery tests all passed."}' }))
    act(() => emit({ type: 'response.done', response: { id: 'echo-r', status: 'completed' } }))
    await act(async () => vi.advanceTimersByTimeAsync(2500))
    expect(api.sendMessage).not.toHaveBeenCalled()
    act(() => emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'echo-send', transcript: 'The microphone recovery tests all passed.' }))
    expect(result.current.draft).toBe('')
    expect(api.sendMessage).not.toHaveBeenCalled()
    playback.release()
    unmount()
    localStorage.removeItem('hapi.voiceAutoSend')
})

it('sends an explicit voice draft to the thread without calling session resume or send', async () => {
    const threadRequest = vi.fn(async () => ({ message: { id: 'thread-message', threadId: 'thread-1', seq: 1, sender: { kind: 'user' }, text: 'Voice text', mentions: [], receipts: [], createdAt: 1 } }))
    const original = { threadRequest, resumeSession: vi.fn(), sendMessage: vi.fn() } as unknown as ApiClient
    const refreshed = vi.fn()
    const key = threadVoiceKey('thread-1')
    const api = createThreadVoiceApi(original, 'thread-1', refreshed)
    const { result } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: key }))
    await act(async () => { await result.current.sendDraft('Please review the latest change.') })
    expect(threadRequest).toHaveBeenCalledWith('/thread-1/send', expect.objectContaining({ text: expect.stringContaining('Please review the latest change.'), mentions: [] }))
    expect(original.resumeSession).not.toHaveBeenCalled()
    expect(original.sendMessage).not.toHaveBeenCalled()
    expect(refreshed).toHaveBeenCalledOnce()
    clearMessageWindow(key)
})

it('updates speech sensitivity on the active transport without reopening the microphone', async () => {
    const { result } = renderVoice()
    act(() => result.current.toggle())
    await waitFor(() => expect(openOmniTransport).toHaveBeenCalled())
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value
    act(() => setVoiceSensitivity(20))
    expect(transport.send).toHaveBeenLastCalledWith({
        type: 'session.update',
        session: { turn_detection: { type: 'server_vad', threshold: 0.62, prefix_padding_ms: 300, silence_duration_ms: 500 } }
    })
    expect(getUserMedia).toHaveBeenCalledOnce()
    localStorage.removeItem('hapi.voiceSensitivity')
})

it('sets the mic from the live switch, so a repeated request never flips it', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    expect(result.current.micOn).toBe(true)
    await act(async () => result.current.setMic(true, 'test'))
    expect(result.current.micOn).toBe(true)
    act(() => result.current.setMic(false, 'test'))
    act(() => result.current.setMic(false, 'test'))
    expect(result.current.micOn).toBe(false)
})

it('preserves manual draft edits against late voice responses and pauses capture until explicitly resumed', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Original draft"}' }))
    expect(result.current.draft).toBe('Original draft')
    act(() => result.current.beginDraftEdit())
    act(() => result.current.editDraft('Manually edited draft'))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Stale draft"}' }))
    expect(result.current.draft).toBe('Manually edited draft')
    expect(result.current.micOn).toBe(false)
    expect(track.stop).toHaveBeenCalled()
    expect(result.current.autoSendSeconds).toBeNull()
    act(() => result.current.endDraftEdit())
    expect(result.current.micOn).toBe(false)
    await act(async () => result.current.toggle())
    expect(result.current.micOn).toBe(true)
    expect(result.current.draft).toBe('Manually edited draft')
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.update', session: expect.objectContaining({ instructions: expect.stringContaining('Manually edited draft') }) }))
})

it('keeps the latest explicit spelling in a correction ledger independent of old draft context', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value as ReturnType<typeof openOmniTransport>
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.update', session: expect.objectContaining({ input_audio_transcription: { model: 'qwen3-asr-flash-realtime' } }) }))
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Check Claud.","corrections":[{"from":"Cloud","to":"Claud"}]}' }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', arguments: '{"text":"Check Claude.","corrections":[{"from":"Cloud","to":"Claude"}]}' }))
    expect(result.current.draft).toBe('Check Claude.')
    const updates = vi.mocked(transport.send).mock.calls.map(([event]) => event as { session?: { instructions?: string } }).filter(event => event.session?.instructions)
    expect(updates.at(-1)?.session?.instructions).toContain('Cloud → Claude')
    act(() => result.current.clearDraft())
    const latest = vi.mocked(transport.send).mock.calls.map(([event]) => event as { session?: { instructions?: string } }).filter(event => event.session?.instructions).at(-1)
    expect(latest?.session?.instructions).toContain('Cloud → Claude')
})

it('exposes the actual sent prompt and text events without connection credentials or audio', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const transport = vi.mocked(openOmniTransport).mock.results[0].value as ReturnType<typeof openOmniTransport>
    const updates = vi.mocked(transport.send).mock.calls.map(([event]) => event.session as { instructions?: string } | undefined).filter(session => session?.instructions)
    expect(result.current.getDebugContext()).toContain(updates.at(-1)!.instructions!)
    act(() => result.current.clearDraft())
    expect(result.current.getDebugContext()).toContain('conversation.item.create')
    expect(result.current.getDebugContext()).toContain('update_draft')
    expect(result.current.getDebugContext()).not.toContain('input_audio_buffer.append')
    expect(result.current.getDebugContext()).not.toContain('relayUrl')
    expect(result.current.getDebugContext()).not.toContain('authToken')
})

it('uses frontend page text rather than backend history for draft context', async () => {
    clearMessageWindow('frontend-only')
    appendOptimisticMessage('frontend-only', { id: 'visible', localId: null, seq: 1, createdAt: Date.now(), content: { role: 'user', content: { type: 'text', text: 'FRONTEND_VISIBLE_WORD' } } })
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: 'UNRELATED_BACKEND_HISTORY', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, unmount } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'frontend-only' }))
    await act(async () => result.current.toggle())
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value as ReturnType<typeof openOmniTransport>
    const prompts = vi.mocked(transport.send).mock.calls.map(([event]) => (event.session as { instructions?: string } | undefined)?.instructions).filter((text): text is string => Boolean(text))
    expect(prompts[0]).toContain('FRONTEND_VISIBLE_WORD')
    expect(prompts.join('\n')).not.toContain('UNRELATED_BACKEND_HISTORY')
    expect(prompts.join('\n')).not.toContain('UI state:')
    expect(prompts.join('\n')).not.toContain('recentSpeech')
    unmount()
    clearMessageWindow('frontend-only')
})

it('continues an explicit session lookup after the requested catalog arrives', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const control = vi.fn(() => ({ sessions: [{ id: 'target', title: 'Microphone recovery' }] }))
    const { result } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'lookup', onUiControl: control }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls.at(-1)![0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value
    act(() => emit({ type: 'session.updated' }))
    act(() => emit({ type: 'response.created', response: { id: 'lookup-response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'control_ui', call_id: 'lookup-call', response_id: 'lookup-response', arguments: JSON.stringify({ command: 'session list "microphone recovery"' }) }))
    act(() => emit({ type: 'response.done', response: { id: 'lookup-response', status: 'completed', output: [{ type: 'function_call', call_id: 'lookup-call' }] } }))
    expect(control).toHaveBeenCalledWith({ action: 'list_sessions', query: 'microphone recovery' })
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'response.create' })
})

it('updates an active connection when the draft language preference changes', async () => {
    const { result } = renderVoice()
    act(() => result.current.toggle())
    await waitFor(() => expect(openOmniTransport).toHaveBeenCalledOnce())
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    act(() => {
        localStorage.setItem('hapi.voiceDraftLanguage', 'zh')
        window.dispatchEvent(new Event('storage'))
    })
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: {
        instructions: expect.stringContaining('草稿输出语言设置为中文'),
    } })
    act(() => {
        localStorage.removeItem('hapi.voiceDraftLanguage')
        window.dispatchEvent(new Event('storage'))
    })
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: {
        instructions: expect.stringContaining('保留用户口述所用的语言'),
    } })
})

it('keeps translation alternatives separate from the sent draft and discards them after edits', async () => {
    localStorage.setItem('hapi.voiceDraftLanguage', 'en')
    const api = {
        getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {},
        resumeSession: async () => 'session-1', sendMessage: vi.fn(async () => ({ seq: 1 })),
    }
    const { result } = renderHook(() => useOmniVoice({ api: api as unknown as ApiClient, baseUrl: '', token: '', sessionId: 'session-1' }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const update = (call_id: string) => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id,
        arguments: JSON.stringify({ text: 'Check the logs.', alternatives: ['Inspect the logs.', 'Review the logs.'] }) })
    act(() => update('translation'))
    expect(result.current.draft).toBe('Check the logs.')
    expect(result.current.alternatives).toEqual(['Inspect the logs.', 'Review the logs.'])
    act(() => result.current.editDraft('Inspect the logs.'))
    expect(result.current.alternatives).toEqual([])
    act(() => update('translation-again'))
    await act(async () => result.current.sendDraft())
    expect(api.sendMessage).toHaveBeenCalledExactlyOnceWith('session-1', '[语音·小精灵整理，可能有同音错字]\nCheck the logs.', expect.any(String))
    expect(result.current.alternatives).toEqual([])
    localStorage.removeItem('hapi.voiceDraftLanguage')
})

it('accepts a main-only translation when alternative translations are disabled', async () => {
    localStorage.setItem('hapi.voiceDraftLanguage', 'en')
    localStorage.setItem('hapi.voiceDraftAlternatives', 'false')
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'main-only', arguments: JSON.stringify({ text: 'Main translation' }) }))
    expect(result.current.draft).toBe('Main translation')
    expect(result.current.draftIssue).toBeNull()
    expect(result.current.alternatives).toEqual([])
    localStorage.removeItem('hapi.voiceDraftLanguage')
    localStorage.removeItem('hapi.voiceDraftAlternatives')
})

it('returns command help and then executes a command without treating help as a UI mutation', async () => {
    const onUiControl = vi.fn(() => ({ ok: true }))
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'commands', onUiControl }))
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    act(() => emit({ type: 'input_audio_buffer.speech_started', item_id: 'settings' }))
    act(() => emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'settings' }))
    act(() => emit({ type: 'response.created', response: { id: 'settings-response' } }))
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'control_ui', call_id: 'help', response_id: 'settings-response', arguments: '{"command":"help draft"}' }))
    expect(onUiControl).not.toHaveBeenCalled()
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'control_ui', call_id: 'status', response_id: 'settings-response', arguments: '{"command":"ui status"}' }))
    expect(onUiControl).toHaveBeenCalledWith({ action: 'ui_status' })
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'control_ui', call_id: 'set', response_id: 'settings-response', arguments: '{"command":"draft alternatives off"}' }))
    expect(onUiControl).toHaveBeenCalledTimes(2)
    expect(onUiControl).toHaveBeenLastCalledWith({ action: 'draft_alternatives', enabled: false })
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'control_ui', call_id: 'language', response_id: 'settings-response', arguments: '{"command":"draft language en"}' }))
    expect(onUiControl).toHaveBeenCalledTimes(3)
    expect(onUiControl).toHaveBeenLastCalledWith({ action: 'draft_language', language: 'en' })
    act(() => emit({ type: 'response.done', response: { id: 'settings-response', status: 'completed', output: [{ type: 'function_call', call_id: 'help' }, { type: 'function_call', call_id: 'status' }, { type: 'function_call', call_id: 'set' }, { type: 'function_call', call_id: 'language' }] } }))
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ type: 'function_call_output', call_id: 'help', output: expect.stringContaining('draft alternatives') }) }))
})


it.each([undefined, [], ['Only one'], ['Same', 'Same'], ['Main translation', 'Other'], ['Valid', ' '], 'not an array', null])('accepts translated main text without usable optional candidates: %j', async alternatives => {
    localStorage.setItem('hapi.voiceDraftLanguage', 'en')
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'valid-candidates',
        arguments: JSON.stringify({ text: 'Previous translation', alternatives: ['First', 'Second'] }) }))
    expect(result.current.alternatives).toHaveLength(2)
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'partial-candidates',
        arguments: JSON.stringify({ text: 'Main translation', alternatives }) }))
    expect(result.current.draft).toBe('Main translation')
    expect(result.current.draftIssue).toBeNull()
    expect(result.current.alternatives).toEqual([])
    localStorage.removeItem('hapi.voiceDraftLanguage')
})


it('keeps draft alternatives independent of translation settings', async () => {
    const { result } = renderVoice()
    await act(async () => result.current.toggle())
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    act(() => emit({ type: 'response.function_call_arguments.done', name: 'update_draft', call_id: 'original-alternatives',
        arguments: JSON.stringify({ text: 'Main draft', alternatives: ['First wording', 'Second wording'] }) }))
    expect(result.current.alternatives).toEqual(['First wording', 'Second wording'])
    act(() => { localStorage.setItem('hapi.voiceDraftLanguage', 'en'); window.dispatchEvent(new Event('storage')) })
    expect(result.current.alternatives).toEqual(['First wording', 'Second wording'])
    act(() => { localStorage.setItem('hapi.voiceDraftLanguage', 'original'); window.dispatchEvent(new Event('storage')) })
    expect(result.current.alternatives).toEqual(['First wording', 'Second wording'])
    act(() => { localStorage.setItem('hapi.voiceDraftAlternatives', 'false'); window.dispatchEvent(new Event('storage')) })
    expect(result.current.alternatives).toEqual([])
    localStorage.removeItem('hapi.voiceDraftLanguage')
    localStorage.removeItem('hapi.voiceDraftAlternatives')
})

it('accepts new frontend context after a reset without reimporting the excluded old messages', async () => {
    const id = 'context-reset-watermark'
    clearMessageWindow(id)
    appendOptimisticMessage(id, { id: 'old-reference', seq: 1, localId: null, createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'EXCLUDED_OLD_REFERENCE' } } })
    const api = { getOmniVoiceSession: async () => ({ title: 'Test', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, unmount } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: id }))
    await act(async () => result.current.toggle())
    await act(async () => result.current.resetHistory())
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value
    expect(JSON.stringify(vi.mocked(transport.send).mock.calls)).not.toContain('EXCLUDED_OLD_REFERENCE')
    act(() => appendOptimisticMessage(id, { id: 'new-reference', seq: 2, localId: null, createdAt: 2, content: { role: 'user', content: { type: 'text', text: 'NEW_CURRENT_CONTEXT' } } }))
    await waitFor(() => expect(transport.send).toHaveBeenCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining('NEW_CURRENT_CONTEXT') } }))
    const updates = JSON.stringify(vi.mocked(transport.send).mock.calls)
    expect(updates).not.toContain('EXCLUDED_OLD_REFERENCE')
    unmount()
    clearMessageWindow(id)
})

it('sends and refreshes selected-session details without including other-session metadata', async () => {
    const api = { getOmniVoiceSession: async () => ({ title: 'Current', context: '', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, rerender } = renderHook(({ directory }) => useOmniVoice({ api, baseUrl: '', token: '', sessionId: 'metadata-context',
        sessionContext: { id: 'metadata-context', title: 'Current task', directory, summary: 'Fix the badge' } }), { initialProps: { directory: '/current/repo' } })
    await act(async () => result.current.toggle())
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value
    expect(JSON.stringify(vi.mocked(transport.send).mock.calls)).toContain('/current/repo')
    rerender({ directory: '/current/worktree' })
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'session.update', session: { instructions: expect.stringContaining('/current/worktree') } })
})

it('loads the selected frontend message page when voice starts without a mounted chat pane', async () => {
    const id = 'voice-empty-pane'
    clearMessageWindow(id)
    const getMessages = vi.fn(async () => ({ messages: [{ id: 'page-message', seq: 1, createdAt: 1, localId: null,
        content: { role: 'user', content: { type: 'text', text: 'SELECTED_PAGE_CONTEXT' } } }], page: { hasMore: false } }))
    const api = { getMessages, getOmniVoiceSession: async () => ({ title: 'Selected', context: 'DO_NOT_USE_BACKEND_SUMMARY', relayUrl: '', token: '' }), reportVoiceEvent: async () => {} } as unknown as ApiClient
    const { result, unmount } = renderHook(() => useOmniVoice({ api, baseUrl: '', token: '', sessionId: id }))
    await act(async () => result.current.toggle())
    const transport = vi.mocked(openOmniTransport).mock.results.at(-1)!.value
    await waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ instructions: expect.stringContaining('SELECTED_PAGE_CONTEXT') }) })))
    expect(result.current.getDebugContext()).toContain('SELECTED_PAGE_CONTEXT')
    expect(getMessages).toHaveBeenCalledExactlyOnceWith(id, expect.objectContaining({ beforeSeq: null, toolGroups: true }))
    expect(JSON.stringify(vi.mocked(transport.send).mock.calls)).not.toContain('DO_NOT_USE_BACKEND_SUMMARY')
    unmount()
    clearMessageWindow(id)
})
