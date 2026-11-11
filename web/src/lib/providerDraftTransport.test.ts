import { describe, expect, it, vi } from 'vitest'
import type { OmniEvent } from './omniTransport'

const asr = vi.hoisted(() => ({ sent: [] as OmniEvent[], emit: (_event: OmniEvent) => {} }))
vi.mock('./omniTransport', () => ({
    openOmniTransport: (options: { onEvent: (event: OmniEvent) => void }) => {
        asr.emit = options.onEvent
        return { send: (event: OmniEvent) => asr.sent.push(event), close: () => {} }
    }
}))

const { openProviderDraftTransport } = await import('./providerDraftTransport')

describe('openProviderDraftTransport', () => {
    it('runs one provider turn per finished utterance and replays its tool calls as Omni events', async () => {
        const events: OmniEvent[] = []
        const run = vi.fn(async () => ({ calls: [{ call_id: 'c1', name: 'update_draft', arguments: '{"text":"hi"}' }] }))
        const transport = openProviderDraftTransport({
            model: { credentialId: 'p', model: 'm' }, run, token: 't', baseUrl: '', authToken: '',
            onEvent: (event) => {
                events.push(event)
                if (event.type === 'response.done') transport.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: 'c1', output: '{"saved":true}' } })
            },
            onClose: () => {}
        })
        transport.send({ type: 'session.update', session: { instructions: 'edit', tools: [{ type: 'function' }], turn_detection: { type: 'server_vad', threshold: 0.5 } } })
        expect(asr.sent[0]).toMatchObject({ session: { input_audio_format: 'pcm', turn_detection: { threshold: 0.5 } } })

        asr.emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'a' })
        expect(run).not.toHaveBeenCalled()
        asr.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'hello' })
        await vi.waitFor(() => expect(events.at(-1)?.type).toBe('response.done'))

        expect(events.map((event) => event.type)).toEqual([
            'input_audio_buffer.speech_stopped', 'conversation.item.input_audio_transcription.completed',
            'response.created', 'response.function_call_arguments.done', 'response.done'
        ])
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'edit', items: [{ type: 'message', text: 'hello' }] }), expect.any(AbortSignal))

        transport.send({ type: 'response.create' })
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
        expect((run.mock.calls[1] as unknown as [{ items: unknown[] }])[0].items).toEqual([
            { type: 'message', text: 'hello' },
            { type: 'function_call', call_id: 'c1', name: 'update_draft', arguments: '{"text":"hi"}' },
            { type: 'function_call_output', call_id: 'c1', output: '{"saved":true}' }
        ])
    })
})
