import { io } from 'socket.io-client'
import { VOICE_MODELS, type VoiceConnectionKind } from '@hapi/protocol/voiceUsage'
import { voiceUsageMeter } from './voiceUsageMeter'

/** DashScope Omni realtime events, as plain objects. */
export type OmniEvent = Record<string, unknown> & { type: string }

export type OmniTransport = {
    send: (event: OmniEvent) => void
    close: () => void
}

/**
 * Opens a DashScope realtime connection of `kind` (default Omni): straight to the relay's `/<kind>-relay` with the
 * short-lived token when a relay is set (the browser cannot add the Authorization header itself), else through
 * the hub's /omni socket pipe.
 * `onClose` fires once when the connection ends without `close()` being called.
 */
export function openOmniTransport(options: {
    relayUrl: string | null
    token: string
    baseUrl: string
    authToken: string
    onEvent: (event: OmniEvent) => void
    onClose: () => void
    kind?: VoiceConnectionKind
}): OmniTransport {
    const kind = options.kind ?? 'omni'
    let closed = false
    const ended = () => {
        if (closed) return
        closed = true
        options.onClose()
    }
    const meter = voiceUsageMeter(VOICE_MODELS[kind], { baseUrl: options.baseUrl, token: options.authToken })
    const receive = (data: unknown) => {
        if (typeof data !== 'string') return
        const event = JSON.parse(data) as OmniEvent
        if (event.type === 'response.done') meter.response((event.response as { usage?: unknown } | undefined)?.usage)
        options.onEvent(event)
    }
    const metered = (event: OmniEvent) => {
        if (event.type === 'input_audio_buffer.append' && typeof event.audio === 'string') meter.base64Audio(event.audio)
        else if (event.type === 'input_text_buffer.append' && typeof event.text === 'string') meter.text(event.text)
        return JSON.stringify(event)
    }

    if (options.relayUrl) {
        const ws = new WebSocket(`${options.relayUrl}/${kind}-relay?token=${encodeURIComponent(options.token)}`)
        let pending: string[] = []
        ws.onopen = () => {
            pending.forEach((data) => ws.send(data))
            pending = []
        }
        ws.onmessage = (message) => receive(message.data)
        ws.onclose = ended
        return {
            send: (event) => {
                const data = metered(event)
                if (ws.readyState === WebSocket.OPEN) ws.send(data)
                else pending.push(data)
            },
            close: () => {
                closed = true
                ws.close()
            }
        }
    }

    const socket = io(`${options.baseUrl}/omni`, { auth: { token: options.authToken }, path: '/socket.io/', reconnection: false })
    socket.emit('omni:open', kind)
    socket.on('omni:down', receive)
    socket.on('omni:closed', ended)
    socket.on('disconnect', ended)
    socket.on('connect_error', ended)
    return {
        send: (event) => socket.emit('omni:up', metered(event)),
        close: () => {
            closed = true
            socket.emit('omni:close')
            socket.disconnect()
        }
    }
}
