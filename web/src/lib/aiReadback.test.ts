import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { openOmniTransport } from './omniTransport'
import { AiReadbackPlayer, aiReadbackText } from './aiReadback'

vi.mock('./omniTransport', () => ({ openOmniTransport: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })) }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })
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
        expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'First reply' }) }] }) }))
        expect(transport.send).not.toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Second reply' }) }] }) }))
        emit({ type: 'response.done', response: { status: 'completed' } })
        expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ content: [{ type: 'input_text', text: JSON.stringify({ text: 'Second reply' }) }] }) }))
        expect(getUserMedia).not.toHaveBeenCalled()
        player.close()
        player.enqueue('Must not speak')
        expect(transport.close).toHaveBeenCalledOnce()
        expect(close).toHaveBeenCalledOnce()
        expect(onError).not.toHaveBeenCalled()
    })
})
