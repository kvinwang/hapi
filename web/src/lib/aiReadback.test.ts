import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { openOmniTransport } from './omniTransport'
import { AiReadbackPlayer, aiReadbackText } from './aiReadback'

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
        const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', token: '', onPlaying: vi.fn(), onError })
        player.enqueue('First reply')
        player.enqueue('Second reply')
        await player.start()
        const transport = vi.mocked(openOmniTransport).mock.results[0].value
        const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
        emit({ type: 'session.updated' })
        expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'First reply', summarize: false }) }] }) }))
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Second reply', summarize: false }) }] }) }))
        emit({ type: 'response.done', response: { status: 'completed' } })
        expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Second reply', summarize: false }) }] }) }))
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
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', token: '', onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    const first = vi.mocked(openOmniTransport).mock.calls[0][0]
    first.onEvent({ type: 'session.updated' })
    player.enqueue('Read this after reconnect')
    first.onClose()
    player.enqueue('Then this')
    await vi.advanceTimersByTimeAsync(1000)
    expect(openOmniTransport).toHaveBeenCalledTimes(2)
    const second = vi.mocked(openOmniTransport).mock.calls[1][0]
    second.onEvent({ type: 'session.updated' })
    const transport = vi.mocked(openOmniTransport).mock.results[1].value
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Read this after reconnect', summarize: false }) }] }) }))
    first.onClose()
    second.onClose()
    player.close()
    await vi.advanceTimersByTimeAsync(60000)
    expect(openOmniTransport).toHaveBeenCalledTimes(2)
})

it('summarizes a long waiting queue without interrupting the current output', async () => {
    vi.stubGlobal('AudioContext', class { resume = async () => {}; close = async () => {} })
    const api = { getOmniVoiceSession: async () => ({ token: 'test', relayUrl: null }) } as unknown as ApiClient
    const player = new AiReadbackPlayer({ api, sessionId: 's1', baseUrl: '', token: '', onPlaying: vi.fn(), onError: vi.fn() })
    await player.start()
    const emit = vi.mocked(openOmniTransport).mock.calls[0][0].onEvent
    const transport = vi.mocked(openOmniTransport).mock.results[0].value
    emit({ type: 'session.updated' })
    player.enqueue('Currently speaking')
    player.enqueue('First important result. '.repeat(100))
    player.enqueue('Second important result. '.repeat(100))
    const sent = () => vi.mocked(transport.send).mock.calls.filter(([event]: [{ type: string }]) => event.type === 'conversation.item.create')
    expect(sent()).toHaveLength(1)
    emit({ type: 'response.done', response: { status: 'completed' } })
    const payload = JSON.parse(sent().at(-1)![0].item.content[0].text)
    expect(payload.summarize).toBe(true)
    expect(payload.text).toContain('First important result.')
    expect(payload.text).toContain('Second important result.')
    expect(payload.text).not.toContain('Currently speaking')
    player.close()
})
