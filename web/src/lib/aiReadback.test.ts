import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { openOmniTransport } from './omniTransport'
import { AiReadbackPlayer, aiReadbackText, latestAiTurn, READBACK_INSTRUCTIONS } from './aiReadback'

vi.mock('./readbackQueue', () => ({ acquireReadbackTurn: vi.fn(async () => () => {}) }))
vi.mock('./omniTransport', () => ({ openOmniTransport: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })) }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
function message(content: unknown): DecryptedMessage {
    return { id: 'm1', localId: null, seq: 1, createdAt: 1, content }
}

describe('AI output readback', () => {
    it('extracts both Codex and Claude output using the chat parser', () => {
        expect(aiReadbackText(message({ role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Codex reply' } } }))).toBe('Codex reply')
        expect(aiReadbackText(message({ role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'Claude reply' }] } } } }))).toBe('Claude reply')
    })

    it('ignores user input, reasoning and tool output', () => {
        for (const data of [{ type: 'reasoning', message: 'Hidden reasoning' }, { type: 'tool-call-result', callId: 'tool', output: 'Command output' }]) {
            expect(aiReadbackText(message({ role: 'agent', content: { type: 'codex', data } }))).toBeNull()
        }
        expect(aiReadbackText(message({ role: 'user', content: { type: 'text', text: 'User prompt' } }))).toBeNull()
    })

    it('owns an output-only FIFO and stopping it closes its transport and queue', async () => {
        const resume = vi.fn(async () => {})
        const close = vi.fn(async () => {})
        const getUserMedia = vi.fn()
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
        vi.stubGlobal('AudioContext', class { resume = resume; close = close })
        const api = { getOmniVoiceSession: vi.fn(async () => ({ token: 'test', relayUrl: null })) } as unknown as ApiClient
        const onError = vi.fn()
        const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError })
        player.enqueue('First reply')
        player.enqueue('Second reply')
        await player.start()
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        emit({ type: 'session.updated' })
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'First reply', summarize: false }) }] }) })))
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Second reply', summarize: false }) }] }) }))
        emit({ type: 'response.done', response: { status: 'completed' } })
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Second reply', summarize: false }) }] }) })))
        const sessions: Array<{ instructions?: string } | undefined> = vi.mocked(transport.send).mock.calls.flatMap(([event]: [{ type: string; session?: { instructions?: string } }]) => event.type === 'session.update' ? [event.session] : [])
        expect(sessions).toHaveLength(3)
        expect(sessions.every(session => session?.instructions === READBACK_INSTRUCTIONS)).toBe(true)
        expect(getUserMedia).not.toHaveBeenCalled()
        player.close()
        player.enqueue('Must not speak')
        expect(transport.close).toHaveBeenCalledOnce()
        expect(close).toHaveBeenCalledOnce()
        expect(onError).not.toHaveBeenCalled()
    })
})


it('reconnects after transport failure, retains queued text, and cancels retries on close', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    const api = { getOmniVoiceSession: vi.fn(async () => ({ token: 'test', relayUrl: null })) } as unknown as ApiClient
    let token = 'initial-token'
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', getToken: () => token, onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    const first = vi.mocked(openOmniTransport).mock.calls[0][0]
    expect(first.authToken).toBe('initial-token')
    first.onEvent({ type: 'session.updated' })
    player.enqueue('Read this after reconnect')
    first.onClose()
    player.enqueue('Then this')
    token = 'refreshed-token'
    await vi.advanceTimersByTimeAsync(1000)
    expect(openOmniTransport).toHaveBeenCalledTimes(2)
    const second = vi.mocked(openOmniTransport).mock.calls[1][0]
    expect(second.authToken).toBe('refreshed-token')
    second.onEvent({ type: 'session.updated' })
    const transport = vi.mocked(openOmniTransport).mock.results[1].value
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Read this after reconnect', summarize: false }) }] }) })))
    first.onClose()
    second.onClose()
    player.close()
    await vi.advanceTimersByTimeAsync(60000)
    expect(openOmniTransport).toHaveBeenCalledTimes(2)
})

it('summarizes a long waiting queue without interrupting the current output', async () => {
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    const api = { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    emit({ type: 'session.updated' })
    player.enqueue('Currently speaking')
    player.enqueue('First important result. '.repeat(5))
    player.enqueue('Second important result. '.repeat(5))
    const sent = () => vi.mocked(transport.send).mock.calls.filter(([event]: [{ type: string }]) => event.type === 'conversation.item.create')
    await vi.waitFor(() => expect(sent()).toHaveLength(1))
    emit({ type: 'response.done', response: { status: 'completed' } })
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    const payload = JSON.parse(sent().at(-1)![0].item.content[0].text)
    expect(payload.summarize).toBe(true)
    expect(payload.text).toContain('First important result.')
    expect(payload.text).toContain('Second important result.')
    expect(payload.text).not.toContain('Currently speaking')
    player.close()
})

it('stops scheduled audio and drops the old queue while allowing later output', async () => {
    const stopped = vi.fn()
    const closed = vi.fn(async () => {})
    const category = { type: 'auto' }
    vi.stubGlobal('navigator', { audioSession: category })
    vi.stubGlobal('AudioContext', class {
        state = 'running'
        currentTime = 0
        destination = {}
        resume = async () => { this.state = 'running' }
        suspend = async () => { this.state = 'suspended' }
        close = closed
        createGain = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() } })
        createBuffer = () => ({ duration: 1, getChannelData: () => new Float32Array(1) })
        createBufferSource = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: stopped, onended: null })
    })
    const api = { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    const first = vi.mocked(openOmniTransport).mock.calls[0][0]
    first.onEvent({ type: 'session.updated' })
    player.enqueue('Current output')
    const firstTransport = vi.mocked(openOmniTransport).mock.results[0].value
    await vi.waitFor(() => expect(firstTransport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
    expect(category.type).toBe('auto')
    first.onEvent({ type: 'response.audio.delta', delta: 'AQA=' })
    first.onEvent({ type: 'response.done', response: { status: 'completed' } })
    player.enqueue('Old queued output')
    player.interrupt()
    expect(stopped).toHaveBeenCalledOnce()
    expect(category.type).toBe('auto')
    expect(closed).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(openOmniTransport).toHaveBeenCalledTimes(2))
    first.onEvent({ type: 'response.audio.delta', delta: 'AQA=' })
    const second = vi.mocked(openOmniTransport).mock.calls[1][0]
    const transport = vi.mocked(openOmniTransport).mock.results[1].value
    second.onEvent({ type: 'session.updated' })
    player.enqueue('New output')
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'New output', summarize: false }) }] }) })))
    expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Old queued output', summarize: false }) }] }) }))
    player.close()
})


it('does not restart an already running output context before playback', async () => {
    const suspend = vi.fn(async () => {})
    vi.stubGlobal('AudioContext', class { state = 'running'; suspend = suspend; resume = async () => {}; close = async () => {} })
    const api = { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    vi.mocked(openOmniTransport).mock.calls[0][0].onEvent({ type: 'session.updated' })
    player.enqueue('Keep the playback context running')
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
    expect(suspend).not.toHaveBeenCalled()
    player.close()
})


it('collects a whole assistant turn across pages and skips tools, reasoning, and older turns', async () => {
    const make = (seq: number, content: unknown) => ({ id: String(seq), seq, localId: null, createdAt: seq, content })
    const reply = (seq: number, text: string) => make(seq, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } })
    const getMessages = vi.fn().mockResolvedValueOnce({ messages: [reply(5, 'Final result'), make(4, { role: 'agent', content: { type: 'codex', data: { type: 'reasoning', message: 'Secret reasoning' } } })], page: { hasMore: true } })
        .mockResolvedValueOnce({ messages: [reply(3, 'Progress update'), make(2, { role: 'user', content: { type: 'text', text: 'Current request' } }), reply(1, 'Older turn')], page: { hasMore: false } })
    expect(await latestAiTurn({ getMessages } as unknown as ApiClient, 'current')).toBe('Progress update\n\nFinal result')
    expect(getMessages).toHaveBeenLastCalledWith('current', { limit: 200, beforeSeq: 4 })
})

it('retains the requested focus in a long summarized replay', async () => {
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    const player = new AiReadbackPlayer({ api: { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    player.enqueue('Test results and remaining issues. '.repeat(20), 'Remaining issues')
    await player.start()
    vi.mocked(openOmniTransport).mock.calls[0][0].onEvent({ type: 'session.updated' })
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
    const request = vi.mocked(transport.send).mock.calls.find(([event]: [{ type: string }]) => event.type === 'conversation.item.create')![0]
    expect(JSON.parse(request.item.content[0].text)).toMatchObject({ summarize: true, focus: 'Remaining issues' })
    player.close()
})

it('forwards an unanswered question once only after a completed tool response', async () => {
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    const send = vi.fn(async () => {})
    const player = new AiReadbackPlayer({ api: { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    player.answer('Tests passed.', 'What is the deployment URL?', send)
    await player.start()
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    emit({ type: 'session.updated' })
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
    emit({ type: 'response.function_call_arguments.done', name: 'forward_question', call_id: 'forward' })
    expect(send).not.toHaveBeenCalled()
    emit({ type: 'response.done', response: { status: 'completed' } })
    emit({ type: 'response.done', response: { status: 'completed' } })
    expect(send).toHaveBeenCalledOnce()
    player.close()
})

it('speaks a grounded tool answer without forwarding the question', async () => {
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    const send = vi.fn(async () => {})
    const player = new AiReadbackPlayer({ api: { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    player.answer('38 tests passed.', 'How many passed?', send)
    await player.start()
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    emit({ type: 'session.updated' })
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
    emit({ type: 'response.function_call_arguments.done', name: 'answer_question', call_id: 'answer', arguments: '{"answer":"38 tests passed."}' })
    emit({ type: 'response.done', response: { status: 'completed' } })
    expect(send).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(openOmniTransport).toHaveBeenCalledTimes(2))
    vi.mocked(openOmniTransport).mock.calls[1][0].onEvent({ type: 'session.updated' })
    const playback = vi.mocked(openOmniTransport).mock.results[1].value
    await vi.waitFor(() => expect(playback.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: '38 tests passed.', summarize: false }) }] }) })))
    player.close()
})


it('plays audio only for a requested read-aloud item, never while idle or deciding an answer', async () => {
    const start = vi.fn()
    vi.stubGlobal('AudioContext', class {
        state = 'running'
        currentTime = 0
        destination = {}
        resume = async () => {}
        close = async () => {}
        createGain = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() } })
        createBuffer = () => ({ duration: 1, getChannelData: () => new Float32Array(1) })
        createBufferSource = () => ({ connect: vi.fn(), disconnect: vi.fn(), start, stop: vi.fn(), onended: null })
    })
    const api = { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    emit({ type: 'session.updated' })
    emit({ type: 'response.audio.delta', delta: 'AQA=' })
    expect(start).not.toHaveBeenCalled()
    player.enqueue('Requested prose')
    await vi.waitFor(() => expect(vi.mocked(openOmniTransport).mock.results[0].value.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
    emit({ type: 'response.audio.delta', delta: 'AQA=' })
    expect(start).toHaveBeenCalledOnce()
    emit({ type: 'response.done', response: { status: 'completed' } })
    emit({ type: 'response.audio.delta', delta: 'AQA=' })
    expect(start).toHaveBeenCalledOnce()
    player.interrupt()
    await vi.waitFor(() => expect(openOmniTransport).toHaveBeenCalledTimes(2))
    const next = vi.mocked(openOmniTransport).mock.calls[1][0].onEvent
    next({ type: 'session.updated' })
    player.answer('Source', 'Question', vi.fn(async () => {}))
    next({ type: 'response.audio.delta', delta: 'AQA=' })
    expect(start).toHaveBeenCalledOnce()
    player.close()
})

it('applies the configured language to each queued item without restarting playback', async () => {
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    let language: 'zh' | 'en' = 'zh'
    const player = new AiReadbackPlayer({
        api: { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient,
        sessionId: 's1', baseUrl: '', getToken: () => '', getLanguage: () => language, onPlaying: vi.fn(), onError: vi.fn()
    })
    try {
        await player.start()
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        const event = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        event({ type: 'session.updated' })
        player.enqueue('Read this in Chinese')
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
            session: expect.objectContaining({ instructions: expect.stringContaining('Mandarin Chinese') })
        })))
        language = 'en'
        player.enqueue('Read this in English')
        event({ type: 'response.done', response: { status: 'completed' } })
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
            session: expect.objectContaining({ instructions: expect.stringContaining('Speak only in English') })
        })))
        expect(openOmniTransport).toHaveBeenCalledOnce()
    } finally { player.close() }
})

it('ignores unsolicited audio and completion events while waiting for the playback turn', async () => {
    const { acquireReadbackTurn } = await import('./readbackQueue')
    let grant!: (release: () => void) => void
    vi.mocked(acquireReadbackTurn).mockImplementationOnce(() => new Promise(resolve => { grant = resolve }))
    const createBufferSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }))
    vi.stubGlobal('AudioContext', class {
        state = 'running'; currentTime = 0; destination = {}
        resume = async () => {}; close = async () => {}; createBufferSource = createBufferSource
        createBuffer = (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) })
        createGain = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1, setValueAtTime: vi.fn() } })
    })
    const player = new AiReadbackPlayer({
        api: { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient,
        sessionId: 's1', baseUrl: '', getToken: () => '', onPlaying: vi.fn(), onError: vi.fn()
    })
    try {
        await player.start()
        const event = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        event({ type: 'session.updated' })
        player.enqueue('Wait for the queue')
        event({ type: 'response.audio.delta', delta: 'AAAA' })
        event({ type: 'response.done', response: { status: 'completed' } })
        expect(createBufferSource).not.toHaveBeenCalled()
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' }))
        grant(() => {})
        await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.create' })))
        event({ type: 'response.audio.delta', delta: 'AAAA' })
        expect(createBufferSource).toHaveBeenCalledOnce()
    } finally { player.close() }
})
