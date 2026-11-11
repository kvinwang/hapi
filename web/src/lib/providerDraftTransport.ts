import { openOmniTransport, type OmniEvent, type OmniTransport } from './omniTransport'

export type VoiceDraftModel = { credentialId: string; model: string }

type Item =
    | { type: 'message'; text: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string }

export type VoiceDraftRequest = VoiceDraftModel & { instructions: string; items: Item[]; tools: unknown[] }
export type RunVoiceDraft = (request: VoiceDraftRequest, signal: AbortSignal) => Promise<{ calls: Array<{ call_id: string; name: string; arguments: string }> }>

const MAX_ITEMS = 60

/**
 * Speaks the Omni realtime protocol to the voice hook, but only transcription runs on DashScope: each finished
 * utterance (and each response.create) becomes one provider model turn whose tool calls are replayed as Omni
 * response events, so the draft logic cannot tell the two apart.
 */
export function openProviderDraftTransport(options: {
    model: VoiceDraftModel
    run: RunVoiceDraft
    token: string
    baseUrl: string
    authToken: string
    onEvent: (event: OmniEvent) => void
    onClose: () => void
}): OmniTransport {
    let instructions = ''
    let tools: unknown[] = []
    let items: Item[] = []
    let responses = 0
    let active: AbortController | null = null
    /** Turns asked for while one runs; transcripts still being recognized hold back the automatic turn. */
    let requested = 0
    let heard = false
    const transcribing = new Set<string>()

    const next = () => {
        if (active) return
        if (requested > 0) requested -= 1
        else if (heard && transcribing.size === 0) heard = false
        else return
        void respond()
    }

    const respond = async () => {
        const id = `resp_provider_${++responses}`
        const controller = new AbortController()
        active = controller
        options.onEvent({ type: 'response.created', response: { id } })
        let response: Record<string, unknown>
        try {
            // A trimmed history must not open with a tool result whose call was cut off.
            const recent = items.slice(-MAX_ITEMS)
            const start = recent.findIndex((item) => item.type === 'message')
            const { calls } = await options.run({ ...options.model, instructions, tools, items: start < 0 ? [] : recent.slice(start) }, controller.signal)
            if (controller.signal.aborted) return
            for (const call of calls) {
                items.push({ type: 'function_call', ...call })
                options.onEvent({ type: 'response.function_call_arguments.done', response_id: id, ...call })
            }
            response = { id, status: 'completed', output: calls.map((call) => ({ type: 'function_call', call_id: call.call_id })) }
        } catch (error) {
            if (controller.signal.aborted) return
            response = { id, status: 'failed', status_details: { error: { message: error instanceof Error ? error.message : String(error) } } }
        }
        active = null
        options.onEvent({ type: 'response.done', response })
        // The hook acknowledges calls on response.done; every call still needs a result for the next turn.
        for (const call of items.filter((item) => item.type === 'function_call')) {
            if (!items.some((item) => item.type === 'function_call_output' && item.call_id === call.call_id)) {
                items.push({ type: 'function_call_output', call_id: call.call_id, output: '{}' })
            }
        }
        next()
    }

    const asr = openOmniTransport({
        relayUrl: null,
        token: options.token,
        baseUrl: options.baseUrl,
        authToken: options.authToken,
        asr: true,
        onClose: options.onClose,
        onEvent: (event) => {
            const itemId = typeof event.item_id === 'string' ? event.item_id : undefined
            if (event.type === 'input_audio_buffer.speech_stopped' && itemId) transcribing.add(itemId)
            if (event.type === 'conversation.item.input_audio_transcription.completed' || event.type === 'conversation.item.input_audio_transcription.failed') {
                if (itemId) transcribing.delete(itemId)
                if (typeof event.transcript === 'string' && event.transcript.trim()) {
                    items.push({ type: 'message', text: event.transcript })
                    heard = true
                }
            }
            options.onEvent(event)
            next()
        }
    })

    return {
        send: (event) => {
            if (event.type === 'session.update') {
                const session = event.session as Record<string, unknown>
                if (typeof session.instructions === 'string') instructions = session.instructions
                if (Array.isArray(session.tools)) tools = session.tools
                if (session.turn_detection) {
                    const { threshold, silence_duration_ms } = session.turn_detection as { threshold?: number; silence_duration_ms?: number }
                    asr.send({ type: 'session.update', session: { input_audio_format: 'pcm', sample_rate: 16000, turn_detection: { type: 'server_vad', threshold, silence_duration_ms } } })
                }
            } else if (event.type === 'input_audio_buffer.append') {
                asr.send(event)
            } else if (event.type === 'conversation.item.create') {
                const item = event.item as { type?: string; call_id?: string; output?: string; content?: Array<{ text?: string }> }
                if (item.type === 'function_call_output') items.push({ type: 'function_call_output', call_id: String(item.call_id), output: String(item.output) })
                else items.push({ type: 'message', text: item.content?.map((part) => part.text ?? '').join('') ?? '' })
                items = items.slice(-MAX_ITEMS * 2)
            } else if (event.type === 'response.create') {
                requested += 1
                next()
            }
        },
        close: () => {
            active?.abort()
            asr.close()
        }
    }
}
