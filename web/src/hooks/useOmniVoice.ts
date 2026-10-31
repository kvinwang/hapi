import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'
import { openOmniTransport, type OmniEvent, type OmniTransport } from '@/lib/omniTransport'
import { isVoiceReadRepliesEnabled } from '@/components/VoiceOrb'

export type OmniVoiceState = 'off' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking' | 'error'

export type OmniCaption = { id: number; role: 'bot' | 'system'; text: string }

type Flags = { on: boolean; mic: boolean; ready: boolean; hearing: boolean; drafting: boolean; working: boolean; playing: boolean; error: boolean }

const OFF: Flags = { on: false, mic: false, ready: false, hearing: false, drafting: false, working: false, playing: false, error: false }

/** While our own reply plays, quieter mic frames are sent as silence so the speaker's echo does not barge in. */
const ECHO_RMS = 0.012
/** Billing is per audio minute: a conversation with nothing going on for this long ends by itself. */
const IDLE_MS = 180_000
const VOICE = 'Tina'
/** Always-present names biasing the transcription (without them "Claude" comes out as "Cloud"). */
const CORPUS_BASE = 'Claude HAPI Codex Omni 小精灵'
const SENT_TAG = '[语音·小精灵整理，可能有同音错字]'

const INSTRUCTIONS = (title: string, context: string) => [
    `你是 HAPI 里的语音助手小精灵。用户 kvin 在手机上用语音给编程助手 Claude 写消息，当前会话是「${title}」。`,
    '你的主要工作是整理草稿：用户每说完一段话，立刻调用 update_draft，把“已有草稿 + 这段新说的话”合并整理成一条完整、通顺、准确的消息，写进 text（完整替换旧草稿）。',
    '保留用户的原意、细节和专业术语，去掉口头禅和重复，不要补充用户没说的内容，不要回答用户的问题，也不要执行它：草稿由用户自己决定何时发送。调用 update_draft 时不要说话。',
    '用户说“清空”“重来”之类：调用 update_draft，text 为空字符串。收到“[草稿已发送]”或“[草稿已清空]”后，从空草稿重新开始。',
    '收到以“[Claude 结果]”开头的消息时，用简短自然的普通话口语转述其中的 reply：不超过两百字就基本照读；更长就概括成两三句重点，最后说“详细内容在屏幕上”。代码、表格、路径、链接不要念。muted 为 true 时只说一句“好了，结果在屏幕上”。',
    '除此之外一律不要说话：用户叫你的名字、打招呼、问你问题，都不要回应；只有称呼或语气词、没有实际内容时，也不要调用 update_draft。',
    ...(context ? ['', '这个会话最近的对话，只用来帮你听准项目名、术语和上下文（比如“Cloud”多半是 Claude）：', context] : [])
].join('\n')

const TOOLS = [{
    type: 'function',
    function: {
        name: 'update_draft',
        description: '用整理好的完整草稿替换暂存区里的待发送内容。',
        parameters: { type: 'object', properties: { text: { type: 'string', description: '完整的新草稿' } }, required: ['text'] }
    }
}]

function deriveState(f: Flags): OmniVoiceState {
    if (f.error) return 'error'
    if (!f.on) return 'off'
    if (!f.ready) return 'connecting'
    if (f.hearing) return 'hearing'
    if (f.playing) return 'speaking'
    if (f.working) return 'working'
    if (f.drafting) return 'thinking'
    return f.mic ? 'listening' : 'off'
}

type Live = {
    transport?: OmniTransport
    audio: AudioContext
    output: GainNode
    analyser: AnalyserNode
    stream?: MediaStream
    node?: AudioWorkletNode
    sources: Set<AudioBufferSourceNode>
    nextTime: number
    ready: boolean
    pendingAudio: string[]
    /** A response is in progress: a new response.create must wait for its response.done. */
    responding: boolean
    wantResponse: boolean
    /** Whether each response.create we sent may be heard, in order; responses the server starts by itself
     * (its voice detection after the user speaks) are drafting only and stay silent. */
    requested: boolean[]
    queuedSpeak: boolean
    audible: boolean
    lastActivity: number
    idleTimer?: ReturnType<typeof setInterval>
    replyAbort?: AbortController
}

function rms(samples: ArrayLike<number>, scale: number): number {
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += (samples[i] / scale) ** 2
    return Math.sqrt(sum / Math.max(1, samples.length))
}

function toBase64(buffer: ArrayBuffer): string {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}

function fromBase64(data: string): Int16Array {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

/**
 * Voice drafting with Qwen Omni realtime, run in the browser (the hub only mints the token). What the user says
 * is summarized by Omni into a draft; `sendDraft` posts it to the session and the agent's reply is read back.
 * The orb is the mic switch (`toggle`); call it from a tap, since iOS starts audio only inside a user gesture.
 * `level` holds the current loudness (0..1) of the mic or of the reply, for the orb's animation.
 */
export function useOmniVoice(options: { api: ApiClient | null; baseUrl: string; token: string; sessionId: string }) {
    const [flags, setFlags] = useState<Flags>(OFF)
    const flagsRef = useRef(flags)
    flagsRef.current = flags
    const [caption, setCaption] = useState<OmniCaption | null>(null)
    const [draft, setDraft] = useState('')
    const [sending, setSending] = useState(false)
    const liveRef = useRef<Live | null>(null)
    const level = useRef(0)
    const optionsRef = useRef(options)
    optionsRef.current = options
    const captionId = useRef(0)

    const patch = useCallback((next: Partial<Flags>) => setFlags((f) => ({ ...f, ...next })), [])
    const say = useCallback((role: OmniCaption['role'], text: string) => {
        if (text.trim()) setCaption({ id: ++captionId.current, role, text: text.trim() })
    }, [])

    const flush = (live: Live) => {
        live.sources.forEach((source) => source.stop())
        live.sources.clear()
        live.nextTime = 0
    }

    const send = (live: Live, event: OmniEvent) => live.transport?.send(event)

    const respond = (live: Live, speak: boolean) => {
        if (live.responding) {
            live.wantResponse = true
            live.queuedSpeak ||= speak
            return
        }
        live.responding = true
        live.requested.push(speak)
        send(live, { type: 'response.create' })
    }

    const tellOmni = (live: Live, text: string, speak: boolean) => {
        send(live, { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
        if (speak) respond(live, true)
    }

    /** `note`: a code or message shown as a caption; anything but 'idle' flashes the error state. */
    const stop = useCallback((note?: string) => {
        const live = liveRef.current
        if (!live) return
        liveRef.current = null
        live.transport?.close()
        live.replyAbort?.abort()
        clearInterval(live.idleTimer)
        live.stream?.getTracks().forEach((track) => track.stop())
        flush(live)
        void live.audio.close()
        level.current = 0
        if (note) say('system', note)
        const failed = Boolean(note) && note !== 'idle'
        setFlags(failed ? { ...OFF, error: true } : OFF)
        if (failed) setTimeout(() => setFlags((f) => (f.on ? f : OFF)), 1500)
    }, [say])

    const play = (live: Live, pcm: Int16Array) => {
        if (pcm.length === 0) return
        const buffer = live.audio.createBuffer(1, pcm.length, 24000)
        const data = buffer.getChannelData(0)
        for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000
        const source = live.audio.createBufferSource()
        source.buffer = buffer
        source.connect(live.output)
        live.nextTime = Math.max(live.nextTime, live.audio.currentTime + 0.05)
        source.start(live.nextTime)
        live.nextTime += buffer.duration
        live.sources.add(source)
        source.onended = () => {
            live.sources.delete(source)
            if (live.sources.size === 0 && liveRef.current === live) patch({ playing: false })
        }
        patch({ playing: true })
    }

    const onEvent = useCallback((live: Live, event: OmniEvent) => {
        if (liveRef.current !== live) return
        switch (event.type) {
            case 'session.updated':
                live.ready = true
                live.pendingAudio.forEach((audio) => send(live, { type: 'input_audio_buffer.append', audio }))
                live.pendingAudio = []
                patch({ ready: true })
                break
            case 'input_audio_buffer.speech_started':
                flush(live)
                live.lastActivity = Date.now()
                patch({ hearing: true, playing: false })
                break
            case 'input_audio_buffer.speech_stopped':
                patch({ hearing: false, drafting: true })
                break
            case 'response.created':
                live.responding = true
                live.audible = live.requested.shift() ?? false
                break
            case 'response.done':
                live.responding = false
                live.lastActivity = Date.now()
                patch({ drafting: false })
                if (live.wantResponse) {
                    live.wantResponse = false
                    const speak = live.queuedSpeak
                    live.queuedSpeak = false
                    respond(live, speak)
                }
                break
            case 'response.audio.delta':
                if (live.audible) play(live, fromBase64(String(event.delta)))
                break
            case 'response.audio_transcript.done':
                if (live.audible) say('bot', String(event.transcript ?? ''))
                break
            case 'response.function_call_arguments.done': {
                if (event.name === 'update_draft') {
                    try {
                        setDraft(String((JSON.parse(String(event.arguments || '{}')) as { text?: unknown }).text ?? '').trim())
                    } catch {
                        // malformed arguments: keep the draft
                    }
                }
                // No response.create: Omni stays silent after updating the draft.
                send(live, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: 'ok' } })
                break
            }
            case 'error': {
                const message = String((event.error as { message?: string } | undefined)?.message ?? '')
                if (message.includes('active response')) {
                    // Our response.create was refused: retry it after the active response, as heard or not.
                    live.responding = true
                    live.wantResponse = true
                    live.queuedSpeak ||= live.requested.pop() ?? false
                } else {
                    console.warn('[omni]', message)
                }
                break
            }
        }
    }, [patch, say])

    /** Opens the Omni session (again after DashScope ends one: sessions are time limited). */
    const connect = useCallback(async (live: Live) => {
        const { api, baseUrl, token, sessionId } = optionsRef.current
        if (!api) return stop('notConfigured')
        let info
        try {
            info = await api.getOmniVoiceSession(sessionId)
        } catch (error) {
            return stop(error instanceof Error && error.message.includes('notConfigured') ? 'notConfigured' : String(error))
        }
        if (liveRef.current !== live) return
        live.ready = false
        live.responding = false
        live.wantResponse = false
        live.requested = []
        patch({ ready: false })
        const transport = openOmniTransport({
            relayUrl: info.relayUrl,
            token: info.token,
            baseUrl,
            authToken: token,
            onEvent: (event) => onEvent(live, event),
            onClose: () => {
                if (liveRef.current !== live || live.transport !== transport) return
                if (live.ready) void connect(live)
                else stop('Omni connection failed')
            }
        })
        live.transport = transport
        transport.send({
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                voice: VOICE,
                instructions: INSTRUCTIONS(info.title, info.context),
                tools: TOOLS,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm24',
                // The corpus biases recognition toward the project's own words ("Cloud" -> "Claude").
                input_audio_transcription: { model: 'gummy-realtime-v1', corpus: { text: `${CORPUS_BASE}\n${info.title}\n${info.context}` } },
                turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
            }
        })
    }, [onEvent, patch, stop])

    /** The orb is the mic switch: on opens the microphone; the conversation stays connected while it is off. */
    const micOn = useCallback(async (live: Live) => {
        patch({ mic: true })
        try {
            live.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            })
            const node = await addPcm16Worklet(live.audio)
            live.node = node
            node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
                if (liveRef.current !== live) return
                const frame = new Int16Array(event.data)
                const loud = rms(frame, 0x8000)
                const playing = live.sources.size > 0
                if (!playing) level.current = Math.min(1, loud * 8)
                const audio = toBase64(playing && loud < ECHO_RMS ? new ArrayBuffer(event.data.byteLength) : event.data)
                if (live.ready) send(live, { type: 'input_audio_buffer.append', audio })
                else if (live.pendingAudio.push(audio) > 60) live.pendingAudio.shift()
            }
            live.audio.createMediaStreamSource(live.stream).connect(node)
        } catch (error) {
            stop(error instanceof DOMException && error.name === 'NotAllowedError' ? 'micPermission' : String(error))
        }
    }, [patch, stop])

    /** Off: no more listening, but what was already said still goes into the draft. */
    const micOff = useCallback((live: Live) => {
        live.stream?.getTracks().forEach((track) => track.stop())
        live.stream = undefined
        live.node?.disconnect()
        live.node = undefined
        level.current = 0
        patch({ mic: false, hearing: false })
        if (live.ready && !live.responding) {
            send(live, { type: 'input_audio_buffer.commit' })
            respond(live, false)
        }
    }, [patch])

    const start = useCallback(async () => {
        if (liveRef.current) return
        // Created synchronously inside the tap, so iOS lets it play.
        const audio = new AudioContext()
        void audio.resume()
        const output = audio.createGain()
        const analyser = audio.createAnalyser()
        analyser.fftSize = 512
        output.connect(analyser)
        analyser.connect(audio.destination)
        const live: Live = {
            audio, output, analyser, sources: new Set(), nextTime: 0, ready: false, pendingAudio: [],
            responding: false, wantResponse: false, requested: [], queuedSpeak: false, audible: false, lastActivity: Date.now()
        }
        liveRef.current = live
        setFlags({ ...OFF, on: true, mic: true })
        live.idleTimer = setInterval(() => {
            const f = flagsRef.current
            if (!f.working && !live.responding && Date.now() - live.lastActivity > IDLE_MS) stop(f.mic ? 'idle' : undefined)
        }, 10_000)
        await Promise.all([micOn(live), connect(live)])
    }, [connect, micOn, stop])

    // The reply's loudness drives the orb while it speaks.
    useEffect(() => {
        if (!flags.playing) return
        const live = liveRef.current
        if (!live) return
        const samples = new Float32Array(live.analyser.fftSize)
        let frame = 0
        const tick = () => {
            live.analyser.getFloatTimeDomainData(samples)
            level.current = Math.min(1, rms(samples, 1) * 5)
            frame = requestAnimationFrame(tick)
        }
        tick()
        return () => cancelAnimationFrame(frame)
    }, [flags.playing])

    // The draft belongs to its session: switching sessions ends the conversation.
    useEffect(() => {
        stop()
        setDraft('')
    }, [options.sessionId, stop])

    useEffect(() => () => stop(), [stop])

    const toggle = useCallback(() => {
        const live = liveRef.current
        if (!live) void start()
        else if (flagsRef.current.mic) micOff(live)
        else void micOn(live)
    }, [micOff, micOn, start])

    const clearDraft = useCallback(() => {
        setDraft('')
        const live = liveRef.current
        if (live) tellOmni(live, '[草稿已清空]', false)
    }, [])

    /** Sends the draft to the session, then has Omni read the agent's reply once the turn ends. */
    const sendDraft = useCallback(async () => {
        const { api, sessionId } = optionsRef.current
        const text = draft.trim()
        if (!api || !text || sending) return
        setSending(true)
        let target: string
        let seq: number
        try {
            target = await api.resumeSession(sessionId)
            seq = (await api.sendMessage(target, `${SENT_TAG}\n${text}`)).seq
        } catch (error) {
            say('system', error instanceof Error ? error.message : String(error))
            return
        } finally {
            setSending(false)
        }
        setDraft('')
        const live = liveRef.current
        if (!live) return
        tellOmni(live, '[草稿已发送]', false)
        live.replyAbort?.abort()
        const abort = new AbortController()
        live.replyAbort = abort
        patch({ working: true })
        try {
            for (;;) {
                const result = await api.getOmniVoiceReply(target, seq, abort.signal)
                if (liveRef.current !== live || abort.signal.aborted) return
                if (result.status === 'done') {
                    const payload = isVoiceReadRepliesEnabled() ? { reply: result.reply } : { muted: true }
                    tellOmni(live, `[Claude 结果] ${JSON.stringify(payload)}`, true)
                    break
                }
            }
        } catch {
            // aborted or the hub went away: the reply is simply not read
        } finally {
            if (liveRef.current === live) {
                live.lastActivity = Date.now()
                patch({ working: false })
            }
        }
    }, [draft, patch, say, sending])

    return {
        state: deriveState(flags),
        caption,
        level,
        toggle,
        draft,
        drafting: flags.drafting || flags.hearing,
        sending,
        sendDraft,
        clearDraft
    }
}
