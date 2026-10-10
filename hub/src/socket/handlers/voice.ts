import { randomUUID } from 'node:crypto'
import type { SocketWithData } from '../socketTypes'

const DASHSCOPE_ASR_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'
const ASR_MODEL = 'paraformer-realtime-v2'

type DashScopeEvent = {
    header: { event: string; error_message?: string }
    payload?: { output?: { sentence?: { text?: string; sentence_end?: boolean } } }
}

type Task = {
    ws: WebSocket
    started: boolean
    stopping: boolean
    pending: ArrayBuffer[]
    finish: () => void
}

export type VoiceHandlersDeps = {
    getApiKey: (namespace: string) => string | null
}

// Bun's WebSocket accepts request headers, which DashScope needs for the API key.
const connectDashScope = (apiKey: string): WebSocket =>
    new WebSocket(DASHSCOPE_ASR_URL, { headers: { Authorization: `bearer ${apiKey}` } })

/**
 * Relays 16 kHz mono PCM16 from the browser to DashScope realtime ASR (the key must stay on the hub and
 * go in a header, which browsers cannot set) and streams recognized sentences back as `voice:result`.
 */
export function registerVoiceHandlers(socket: SocketWithData, deps: VoiceHandlersDeps): void {
    let task: Task | null = null

    const end = (current: Task, event: 'voice:done' | 'voice:error', payload?: unknown) => {
        if (task !== current) return
        task = null
        socket.emit(event, payload)
        current.ws.close()
    }

    socket.on('voice:start', () => {
        task?.ws.close()
        task = null
        const apiKey = deps.getApiKey(socket.data.namespace ?? '')
        if (!apiKey) {
            socket.emit('voice:error', { code: 'notConfigured' })
            return
        }
        const taskId = randomUUID().replaceAll('-', '')
        const command = (action: string, payload: Record<string, unknown>) =>
            JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload })
        const ws = connectDashScope(apiKey)
        const current: Task = {
            ws,
            started: false,
            stopping: false,
            pending: [],
            finish: () => ws.send(command('finish-task', { input: {} }))
        }
        task = current

        ws.onopen = () => ws.send(command('run-task', {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: ASR_MODEL,
            parameters: { format: 'pcm', sample_rate: 16000 },
            input: {}
        }))
        ws.onmessage = (message) => {
            if (task !== current || typeof message.data !== 'string') return
            const event = JSON.parse(message.data) as DashScopeEvent
            switch (event.header.event) {
                case 'task-started':
                    current.started = true
                    current.pending.forEach((chunk) => ws.send(chunk))
                    current.pending = []
                    if (current.stopping) current.finish()
                    break
                case 'result-generated': {
                    const sentence = event.payload?.output?.sentence
                    if (sentence) socket.emit('voice:result', { text: sentence.text ?? '', final: Boolean(sentence.sentence_end) })
                    break
                }
                case 'task-finished':
                    end(current, 'voice:done')
                    break
                case 'task-failed':
                    end(current, 'voice:error', { message: event.header.error_message ?? 'ASR failed' })
                    break
            }
        }
        ws.onerror = () => end(current, 'voice:error', { message: 'ASR connection failed' })
        ws.onclose = () => end(current, 'voice:done')
    })

    socket.on('voice:audio', (chunk: unknown) => {
        if (!task || task.stopping || !(chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk))) return
        const data = chunk instanceof ArrayBuffer
            ? chunk
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice().buffer
        if (task.started) task.ws.send(data)
        else task.pending.push(data)
    })

    socket.on('voice:stop', () => {
        if (!task || task.stopping) return
        task.stopping = true
        if (task.started) task.finish()
    })

    socket.on('disconnect', () => {
        task?.ws.close()
        task = null
    })
}
