import type { SocketWithData } from '../socketTypes'
import type { SyncEngine, SyncEvent } from '../../sync/syncEngine'
import { extractMessageEventType } from '../../notifications/eventParsing'

const OMNI_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-omni-flash-realtime'
const VOICE = 'Tina'
const SILENCE_MS = 500
/** Billing is per audio minute: a conversation with nothing said for this long ends by itself. */
const IDLE_MS = 180_000
/** How long a tool call waits for Claude before Omni says it is still working (the result follows later). */
const TURN_WAIT_MS = 60_000
const REPLY_MAX_CHARS = 3000

const INSTRUCTIONS = (title: string) => [
    `你是 HAPI 里的实时语音助手，名叫小精灵。用户 kvin 在手机上通过你和编程助手 Claude 交流，当前会话是「${title}」。`,
    '你说的话会直接播放出来：用简短自然的普通话口语，先说结论，不要列表、表情、网址或代码。',
    '凡是和工作有关的请求、问题或指令（写代码、改文件、查资料、问进度、问项目情况等），先说一句很短的话（每次换个说法，比如“好，我转给 Claude”），',
    '然后调用 ask_assistant，把用户的请求完整写进 request（保留原意，可以把口语整理通顺，但不要补充用户没说的内容）。',
    'ask_assistant 和 answer_permission 的结果：',
    '- status=done：转述 reply。不超过两百字就基本照读；更长就概括成两三句重点，最后说“详细内容在屏幕上”。代码、表格、路径、链接不要念，只说“有一段代码”之类。',
    '- status=permission：告诉用户 Claude 想做什么（request），问批不批准；用户回答后调用 answer_permission。',
    '- status=working：告诉用户 Claude 还在处理，好了会告诉他。之后收到以“[Claude 结果]”开头的消息时，按上面同样的规则转述。',
    '用户说停下、别做了、取消，调用 stop_assistant。用户问 Claude 刚才说了什么，调用 read_last_reply 再转述。',
    '麦克风一直开着：周围别人说话、半句话、口头禅、杂音都调用 ignore，而且不要说话；拿不准时当作不是对你说的。纯闲聊就自己简短回答。'
].join('\n')

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } }
})

const TOOLS = [
    fn('ask_assistant', '把用户的请求发给 Claude，等它这一轮做完（或需要授权），返回结果。',
        { request: { type: 'string', description: '用户的完整请求' } }, ['request']),
    fn('answer_permission', '批准或拒绝 Claude 正在等待的授权请求，然后继续等它做完。',
        { approve: { type: 'boolean' } }, ['approve']),
    fn('stop_assistant', '让 Claude 停止当前这一轮。'),
    fn('read_last_reply', '读取 Claude 最近一条回复。'),
    fn('ignore', '这句话不是对小精灵说的：保持沉默。')
]

/** What Omni should read: code, tables and links collapsed into a spoken placeholder. */
export function speakable(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, '（一段代码）')
        .replace(/(?:^\|.*\|[ \t]*(?:\n|$))+/gm, '（一张表）\n')
        .replace(/https?:\/\/\S+/g, '（链接）')
        .replace(/`([^`\n]+)`/g, '$1')
        .trim()
        .slice(-REPLY_MAX_CHARS)
}

type Outcome = Record<string, unknown>

type Turn = {
    afterSeq: number
    seenRequests: Set<string>
    /** Set while a tool call waits for the outcome; otherwise the outcome is pushed to Omni as a message. */
    resolve: ((outcome: Outcome) => void) | null
}

type Conn = {
    ws: WebSocket
    sessionId: string
    ready: boolean
    pending: string[]
    /** A response is in progress: a new response.create must wait for its response.done. */
    responding: boolean
    wantResponse: boolean
    /** Drop reply audio from the user's barge-in until the next response starts, and for ignored responses. */
    mute: boolean
    lastActivity: number
    turn: Turn | null
    unsubscribe: () => void
    idleTimer: ReturnType<typeof setInterval>
}

export type OmniHandlersDeps = {
    getApiKey: (namespace: string) => string | null
    getSyncEngine: () => SyncEngine | null
}

/**
 * Continuous voice conversation with Qwen Omni realtime, relayed by the hub (the DashScope key stays here).
 * Omni hands work to the session's agent through ask_assistant and reads the agent's reply back.
 * Browser -> hub: omni:start {sessionId}, omni:audio (16 kHz PCM16), omni:stop.
 * Hub -> browser: omni:audio (24 kHz PCM16), omni:event {type: ready|speech_started|speech_stopped|user|bot|working|done|idle|error}.
 */
export function registerOmniHandlers(socket: SocketWithData, deps: OmniHandlersDeps): void {
    let conn: Conn | null = null
    const tell = (type: string, extra: Record<string, unknown> = {}) => socket.emit('omni:event', { type, ...extra })

    const close = (current: Conn, reason?: 'idle' | 'error', message?: string) => {
        if (conn !== current) return
        conn = null
        current.unsubscribe()
        clearInterval(current.idleTimer)
        current.turn?.resolve?.({ status: 'cancelled' })
        current.ws.close()
        if (reason) tell(reason, message ? { message } : {})
    }

    const send = (current: Conn, message: Record<string, unknown>) => {
        const data = JSON.stringify(message)
        if (current.ready) current.ws.send(data)
        else current.pending.push(data)
        // At most ~3 s of audio (50 ms frames) waits for the upstream session.
        if (current.pending.length > 60) current.pending.shift()
    }

    const respond = (current: Conn) => {
        if (current.responding) {
            current.wantResponse = true
            return
        }
        current.responding = true
        send(current, { type: 'response.create' })
    }

    const engineOf = () => {
        const engine = deps.getSyncEngine()
        if (!engine) throw new Error('hub not ready')
        return engine
    }

    const assistantText = (sessionId: string, afterSeq: number) => engineOf()
        .getSessionHistory(sessionId, { role: 'assistant', afterSeq, limit: 50 })
        .messages.map((message) => message.text?.trim())
        .filter(Boolean)
        .join('\n\n')

    const pendingRequests = (sessionId: string) => Object.entries(engineOf().getSession(sessionId)?.agentState?.requests ?? {})

    const settle = (current: Conn, outcome: Outcome) => {
        const turn = current.turn
        if (!turn) return
        if (outcome.status !== 'permission') current.turn = null
        tell('working', { on: false })
        if (turn.resolve) {
            turn.resolve(outcome)
            turn.resolve = null
            return
        }
        send(current, {
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Claude 结果] ${JSON.stringify(outcome)}` }] }
        })
        respond(current)
    }

    const onSyncEvent = (current: Conn, event: SyncEvent) => {
        const turn = current.turn
        if (!turn || !('sessionId' in event) || event.sessionId !== current.sessionId) return
        if (event.type === 'message-received' && extractMessageEventType(event) === 'ready') {
            settle(current, { status: 'done', reply: speakable(assistantText(current.sessionId, turn.afterSeq)) })
            return
        }
        if (event.type === 'session-updated') {
            const fresh = pendingRequests(current.sessionId).filter(([id]) => !turn.seenRequests.has(id))
            if (fresh.length === 0) return
            fresh.forEach(([id]) => turn.seenRequests.add(id))
            const request = fresh.map(([, r]) => `${r.tool}: ${JSON.stringify(r.arguments ?? {}).slice(0, 160)}`).join('; ')
            settle(current, { status: 'permission', request })
        }
    }

    /** Waits for the agent's next stop (turn end or a permission request), or reports it is still working. */
    const awaitTurn = (current: Conn, afterSeq: number) => new Promise<Outcome>((resolve) => {
        const turn: Turn = current.turn ?? {
            afterSeq,
            seenRequests: new Set(pendingRequests(current.sessionId).map(([id]) => id)),
            resolve: null
        }
        turn.resolve = resolve
        current.turn = turn
        tell('working', { on: true })
        setTimeout(() => {
            if (turn.resolve !== resolve) return
            turn.resolve = null
            resolve({ status: 'working' })
        }, TURN_WAIT_MS)
    })

    const runTool = async (current: Conn, name: string, args: Record<string, unknown>): Promise<Outcome | null> => {
        const engine = engineOf()
        const sessionId = current.sessionId
        switch (name) {
            case 'ignore':
                current.mute = true
                return null
            case 'ask_assistant': {
                const request = String(args.request ?? '').trim()
                if (!request) return { status: 'error', message: 'empty request' }
                const { seq } = await engine.sendMessage(sessionId, { text: `[语音·小精灵转述]\n${request}`, sentFrom: 'webapp' })
                return await awaitTurn(current, seq)
            }
            case 'answer_permission': {
                const requests = pendingRequests(sessionId)
                if (requests.length === 0) return { status: 'error', message: '没有等待中的授权请求' }
                await Promise.all(requests.map(([id]) => args.approve === true
                    ? engine.approvePermission(sessionId, id)
                    : engine.denyPermission(sessionId, id)))
                return await awaitTurn(current, current.turn?.afterSeq ?? engine.getLatestMessageSeq(sessionId))
            }
            case 'stop_assistant':
                await engine.abortSession(sessionId)
                if (current.turn) settle(current, { status: 'stopped' })
                return { status: 'stopped' }
            case 'read_last_reply': {
                const last = engine.getSessionHistory(sessionId, { role: 'assistant', tail: 1, limit: 1 }).messages[0]?.text
                return { status: 'done', reply: speakable(last ?? '') }
            }
            default:
                return { status: 'error', message: `unknown function ${name}` }
        }
    }

    const callTool = async (current: Conn, event: { name?: string; call_id?: string; arguments?: string }) => {
        let args: Record<string, unknown> = {}
        try {
            args = JSON.parse(event.arguments || '{}') as Record<string, unknown>
        } catch {
            // malformed arguments: run with none
        }
        let outcome: Outcome | null
        try {
            outcome = await runTool(current, event.name ?? '', args)
        } catch (error) {
            outcome = { status: 'error', message: error instanceof Error ? error.message : String(error) }
        }
        current.lastActivity = Date.now()
        if (conn !== current) return
        send(current, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(outcome ?? { status: 'ok' }) } })
        if (outcome) respond(current)
    }

    const onUpstream = (current: Conn, raw: string) => {
        const event = JSON.parse(raw) as Record<string, unknown> & { type: string }
        switch (event.type) {
            case 'session.updated':
                current.ready = true
                current.pending.forEach((data) => current.ws.send(data))
                current.pending = []
                tell('ready')
                break
            case 'response.audio.delta':
                if (!current.mute) socket.emit('omni:audio', Buffer.from(String(event.delta), 'base64'))
                break
            case 'input_audio_buffer.speech_started':
                current.mute = true
                current.lastActivity = Date.now()
                tell('speech_started')
                break
            case 'input_audio_buffer.speech_stopped':
                tell('speech_stopped')
                break
            case 'response.created':
                current.mute = false
                current.responding = true
                break
            case 'response.done':
                current.responding = false
                current.lastActivity = Date.now()
                tell('done')
                if (current.wantResponse) {
                    current.wantResponse = false
                    respond(current)
                }
                break
            case 'response.function_call_arguments.done':
                void callTool(current, event as { name?: string; call_id?: string; arguments?: string })
                break
            case 'conversation.item.input_audio_transcription.completed':
                tell('user', { text: String(event.transcript ?? ''), final: true })
                break
            case 'response.audio_transcript.done':
                if (!current.mute) tell('bot', { text: String(event.transcript ?? ''), final: true })
                break
            case 'error': {
                const message = String((event.error as { message?: string } | undefined)?.message ?? 'Omni error')
                if (message.includes('active response')) {
                    current.responding = true
                    current.wantResponse = true
                }
                break
            }
        }
    }

    socket.on('omni:start', (payload: { sessionId?: unknown } | undefined) => {
        if (conn) close(conn)
        const namespace = socket.data.namespace ?? ''
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
        const engine = deps.getSyncEngine()
        const session = engine?.getSession(sessionId)
        if (!engine || !session || session.namespace !== namespace) {
            tell('error', { message: 'session not found' })
            return
        }
        const apiKey = deps.getApiKey(namespace)
        if (!apiKey) {
            tell('error', { code: 'notConfigured' })
            return
        }
        // Bun's WebSocket accepts request headers, which DashScope needs for the API key.
        const ws = new WebSocket(OMNI_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
        const current: Conn = {
            ws,
            sessionId,
            ready: false,
            pending: [],
            responding: false,
            wantResponse: false,
            mute: false,
            lastActivity: Date.now(),
            turn: null,
            unsubscribe: engine.subscribe((event) => onSyncEvent(current, event)),
            idleTimer: setInterval(() => {
                if (!current.turn && !current.responding && Date.now() - current.lastActivity > IDLE_MS) close(current, 'idle')
            }, 10_000)
        }
        conn = current
        const title = session.metadata?.name || session.metadata?.summary?.text || session.metadata?.path || ''
        ws.onopen = () => ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                voice: VOICE,
                instructions: INSTRUCTIONS(title),
                tools: TOOLS,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm24',
                input_audio_transcription: { model: 'gummy-realtime-v1' },
                turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: SILENCE_MS }
            }
        }))
        ws.onmessage = (message) => {
            if (conn === current && typeof message.data === 'string') onUpstream(current, message.data)
        }
        ws.onerror = () => close(current, 'error', 'Omni connection failed')
        ws.onclose = () => close(current, 'idle')
    })

    socket.on('omni:audio', (chunk: unknown) => {
        if (!conn || !(chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk))) return
        const bytes = chunk instanceof ArrayBuffer
            ? Buffer.from(chunk)
            : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        send(conn, { type: 'input_audio_buffer.append', audio: bytes.toString('base64') })
    })

    socket.on('omni:stop', () => {
        if (conn) close(conn)
    })

    socket.on('disconnect', () => {
        if (conn) close(conn)
    })
}
