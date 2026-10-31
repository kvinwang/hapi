import type { SocketWithData } from '../socketTypes'

const OMNI_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime'

export type OmniHandlersDeps = {
    getApiKey: (namespace: string) => string | null
}

/**
 * Fallback transport for the browser's Qwen Omni conversation when no relay (HAPI_OMNI_RELAY_URL) is set: a
 * plain pipe of DashScope realtime events, with the key added here. The conversation logic runs in the browser.
 * omni:open -> upstream opened; omni:up (JSON string) -> upstream; upstream -> omni:down; omni:closed when it ends.
 */
export function registerOmniHandlers(socket: SocketWithData, deps: OmniHandlersDeps): void {
    let upstream: WebSocket | null = null
    let pending: string[] = []

    const close = () => {
        const ws = upstream
        upstream = null
        pending = []
        ws?.close()
    }

    socket.on('omni:open', () => {
        close()
        const apiKey = deps.getApiKey(socket.data.namespace ?? '')
        if (!apiKey) {
            socket.emit('omni:closed', { error: 'notConfigured' })
            return
        }
        // Bun's WebSocket accepts request headers, which DashScope needs for the key.
        const ws = new WebSocket(OMNI_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
        upstream = ws
        ws.onopen = () => {
            pending.forEach((data) => ws.send(data))
            pending = []
        }
        ws.onmessage = (message) => {
            if (upstream === ws && typeof message.data === 'string') socket.emit('omni:down', message.data)
        }
        ws.onclose = () => {
            if (upstream !== ws) return
            upstream = null
            socket.emit('omni:closed', {})
        }
    })

    socket.on('omni:up', (data: unknown) => {
        if (!upstream || typeof data !== 'string') return
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
        else pending.push(data)
    })

    socket.on('omni:close', close)
    socket.on('disconnect', close)
}
