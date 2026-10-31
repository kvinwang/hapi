import { io } from 'socket.io-client'

/** DashScope Omni realtime events, as plain objects. */
export type OmniEvent = Record<string, unknown> & { type: string }

export type OmniTransport = {
    send: (event: OmniEvent) => void
    close: () => void
}

/**
 * Opens a Qwen Omni realtime connection: straight to the relay with the short-lived token when one is set
 * (the browser cannot add the Authorization header itself), else through the hub's /omni socket pipe.
 * `onClose` fires once when the connection ends without `close()` being called.
 */
export function openOmniTransport(options: {
    relayUrl: string | null
    token: string
    baseUrl: string
    authToken: string
    onEvent: (event: OmniEvent) => void
    onClose: () => void
}): OmniTransport {
    let closed = false
    const ended = () => {
        if (closed) return
        closed = true
        options.onClose()
    }
    const receive = (data: unknown) => {
        if (typeof data === 'string') options.onEvent(JSON.parse(data) as OmniEvent)
    }

    if (options.relayUrl) {
        const ws = new WebSocket(`${options.relayUrl}?token=${encodeURIComponent(options.token)}`)
        let pending: string[] = []
        ws.onopen = () => {
            pending.forEach((data) => ws.send(data))
            pending = []
        }
        ws.onmessage = (message) => receive(message.data)
        ws.onclose = ended
        return {
            send: (event) => {
                const data = JSON.stringify(event)
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
    socket.emit('omni:open')
    socket.on('omni:down', receive)
    socket.on('omni:closed', ended)
    socket.on('disconnect', ended)
    socket.on('connect_error', ended)
    return {
        send: (event) => socket.emit('omni:up', JSON.stringify(event)),
        close: () => {
            closed = true
            socket.emit('omni:close')
            socket.disconnect()
        }
    }
}
