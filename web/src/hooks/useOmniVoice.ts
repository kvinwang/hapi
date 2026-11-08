import { executeFrontendCommand } from '@/lib/frontendCommands'
import { useVoicePanelSettings } from './useVoicePanelSettings'
import { VoiceContextDebug } from '@/lib/voiceContextDebug'
import { createMicrophoneGate } from '@/lib/microphoneGate'
import { spokenUiControl, VOICE_UI_INSTRUCTIONS, VOICE_UI_TOOL, type VoiceUiControl } from '@/lib/voiceUiControl'
import { createCaptureActivity, isMediaPlaybackActive, isPlaybackEcho, PLAYBACK_ECHO_RMS } from '@/lib/mediaPlayback'
import { VOICE_DRAFT_TOOLS, voiceDraftInstructions, draftUpdateSchema, buildVoiceDraftContext, mergeVoiceCorrections, recentVoiceConversation, type VoiceCorrection, type DeferredSpeech } from '@/lib/voiceDraftIntent'
import { terminalVoiceInstructions } from '@/lib/terminalVoicePrompt'
import { TERMINAL_KEYS, spokenTerminalKey, type TerminalKey } from '@/lib/terminalKeys'
import { getVoiceTerminalExecute, terminalVoiceInput } from '@/lib/terminalVoice'
import { voiceDraftCommand } from '@/lib/voiceDraftCommand'
import { useVoiceAutoSend } from '@/hooks/useVoiceAutoSend'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceApi } from '@/lib/voiceApi'
import { addPcm16Worklet, stopPcm16Worklet } from '@/lib/pcm16Worklet'
import { OmniDraftTurns } from '@/lib/omniDraftTurns'
import { createVoiceAudioSession } from '@/lib/voice-audio-session'
import { makeClientSideId } from '@/lib/messages'
import { appendOptimisticMessage, updateMessageStatus, getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { optimisticUserMessage } from '@/hooks/mutations/useSendMessage'
import { openOmniTransport, type OmniEvent, type OmniTransport } from '@/lib/omniTransport'
import { getVoiceSensitivity, getVoiceThreshold, subscribeVoiceSensitivity } from '@/lib/voiceSensitivity'

export type OmniVoiceState = 'off' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking' | 'recovering' | 'error'

export type VoiceDraftIssue = { reason: 'noDraft' | 'service' | 'interrupted' | 'invalidDraft'; detail?: string }

export type OmniCaption = { id: number; role: 'bot' | 'system'; text: string }

type Flags = { on: boolean; mic: boolean; recovering: boolean; ready: boolean; hearing: boolean; drafting: boolean; working: boolean; playing: boolean; error: boolean }

const OFF: Flags = { on: false, mic: false, recovering: false, ready: false, hearing: false, drafting: false, working: false, playing: false, error: false }

/** While our own reply plays, quieter mic frames are sent as silence so the speaker's echo does not barge in. */
const ECHO_RMS = PLAYBACK_ECHO_RMS
/** Billing is per audio minute: a conversation with nothing going on for this long ends by itself. */
const IDLE_MS = 180_000
const VOICE = 'Tina'
const SENT_TAG = '[语音·小精灵整理，可能有同音错字]'

function micRecoveryDelay(attempt: number): number {
    return Math.min(30000, 2000 * 2 ** Math.min(Math.max(0, attempt - 1), 4))
}


function createAudioGraph() {
    const audio = new AudioContext()
    const output = audio.createGain()
    const analyser = audio.createAnalyser()
    const captureSink = audio.createGain()
    analyser.fftSize = 512
    captureSink.gain.value = 0
    output.connect(analyser)
    analyser.connect(audio.destination)
    captureSink.connect(audio.destination)
    return { audio, output, analyser, captureSink }
}

async function resumeAudio(audio: AudioContext): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            audio.resume(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Audio resume timed out')), 5000) })
        ])
    } finally {
        clearTimeout(timer)
    }
}

function deriveState(f: Flags): OmniVoiceState {
    if (f.error) return 'error'
    if (!f.on) return 'off'
    if (!f.ready) return 'connecting'
    if (f.recovering) return 'recovering'
    if (f.hearing) return 'hearing'
    if (f.playing) return 'speaking'
    if (f.working) return 'working'
    if (f.drafting) return 'thinking'
    return f.mic ? 'listening' : 'off'
}

type Live = {
    transport?: OmniTransport
    audio: AudioContext
    captureSink: GainNode
    connectionGen: number
    instructions: string
    awaitingDraft: boolean
    draftDismissed: boolean
    repair: { texts: string[]; explicit: boolean } | null
    draftTurns: OmniDraftTurns
    pendingCalls: Map<string, { responseId?: string; output: string }>
    handledCalls: Set<string>
    uiItems: Set<string>
    audioSession: ReturnType<typeof createVoiceAudioSession>
    output: GainNode
    analyser: AnalyserNode
    stream?: MediaStream
    source?: MediaStreamAudioSourceNode
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
    /** Mic health: iOS may end, mute or starve the microphone (lock screen, another app, Siri) silently. */
    lastFrameAt: number
    recovering: boolean
    opening: boolean
    recoveryGen: number
    recoveryAttempts: number
    retryAt: number
    healthyFrames: number
    /** The mic switch, set at once on a tap (React state lags), and a counter that voids an opening
     * superseded while it awaited the microphone: there is never more than one mic pipeline. */
    captureActivity?: ReturnType<typeof createCaptureActivity>
    speechLevels: Map<string, number>
    echoItems: Set<string>
    speechItemId?: string
    latestRms: number
    lastDraftItemId?: string
    micWanted: boolean
    micGen: number
    stats: { frames: number; maxRms: number; speechStarts: number; since: number }
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
export function useOmniVoice(options: { api: VoiceApi | null; baseUrl: string; token: string; sessionId: string; target?: 'chat' | 'terminal'; writeTerminal?: (text: string) => boolean; onUiControl?: (control: VoiceUiControl) => unknown; selectingSession?: boolean; autoSendBlocked?: boolean; onSpeechStart?: () => void }) {
    const { language: draftLanguage, alternativesEnabled } = useVoicePanelSettings()
    const alternativesEnabledRef = useRef(alternativesEnabled)
    alternativesEnabledRef.current = alternativesEnabled
    const draftLanguageRef = useRef(draftLanguage)
    draftLanguageRef.current = draftLanguage
    const [flags, setFlags] = useState<Flags>(OFF)
    const flagsRef = useRef(flags)
    flagsRef.current = flags
    const [caption, setCaption] = useState<OmniCaption | null>(null)
    const [draft, setDraft] = useState('')
    const [translations, setTranslations] = useState<{ text: string; language: string; sessionId: string; alternatives: string[] } | null>(null)
    const target = options.target ?? 'chat'
    const targetRef = useRef(target)
    const savedDrafts = useRef({ chat: '', terminal: '' })
    const draftRef = useRef(draft)
    draftRef.current = draft
    const [deferred, setDeferred] = useState<DeferredSpeech[]>([])
    const deferredRef = useRef(deferred)
    deferredRef.current = deferred
    const [recentSpeech, setRecentSpeech] = useState<string[]>([])
    const speechRef = useRef(recentSpeech)
    speechRef.current = recentSpeech
    const [corrections, setCorrections] = useState<Record<string, VoiceCorrection[]>>({})
    const correctionsRef = useRef(corrections)
    correctionsRef.current = corrections
    const [conversation, setConversation] = useState('')
    const savedSpeech = useRef<Record<'chat' | 'terminal', { deferred: DeferredSpeech[]; speech: string[] }>>({ chat: { deferred: [], speech: [] }, terminal: { deferred: [], speech: [] } })
    const previousSession = useRef(options.sessionId)
    const sessionDrafts = useRef(new Map<string, { drafts: typeof savedDrafts.current; speech: typeof savedSpeech.current }>())
    const resetContext = useRef(false)
    const resetGeneration = useRef(0)
    const [editing, setEditing] = useState(false)
    const [sending, setSending] = useState(false)
    const sendingRef = useRef(false)
    const [silenceSince, setSilenceSince] = useState<number | null>(null)
    const [transcription, setTranscription] = useState<{ itemId: string; text: string } | null>(null)
    const voiceCommandRef = useRef<(command: 'send' | 'clear' | 'include' | 'pause' | TerminalKey, before: string) => void>(() => {})
    const [draftIssue, setDraftIssue] = useState<VoiceDraftIssue | null>(null)
    const debugContext = useRef(new VoiceContextDebug(options.sessionId))
    const liveRef = useRef<Live | null>(null)
    const level = useRef(0)
    const sensitivity = useRef(getVoiceSensitivity())
    const optionsRef = useRef(options)
    optionsRef.current = options
    const captionId = useRef(0)

    const patch = useCallback((next: Partial<Flags>) => setFlags((f) =>
        (Object.keys(next) as Array<keyof Flags>).every((key) => f[key] === next[key]) ? f : { ...f, ...next }
    ), [])
    /** Voice diagnostics land in the hub log ([omni-client]), so a problem on the phone can be looked at later. */
    const report = (event: string, detail: string) => void optionsRef.current.api?.reportVoiceEvent(event, detail).catch(() => {})
    const say = useCallback((role: OmniCaption['role'], text: string) => {
        if (text.trim()) setCaption({ id: ++captionId.current, role, text: text.trim() })
    }, [])

    const flush = (live: Live) => {
        live.sources.forEach((source) => source.stop())
        live.sources.clear()
        live.nextTime = 0
    }

    const frontendConversation = () => {
        if (resetContext.current) return ''
        const state = getMessageWindowState(optionsRef.current.sessionId)
        return recentVoiceConversation([...state.messages, ...state.pending])
    }

    const send = (live: Live, event: OmniEvent) => {
        if (!live.transport) return
        live.transport.send(event)
        debugContext.current.record(event)
    }

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
        setSilenceSince(null)
        if (live.awaitingDraft) setDraftIssue({ reason: 'interrupted', detail: note })
        live.transport?.close()
        clearInterval(live.idleTimer)
        live.stream?.getTracks().forEach((track) => track.stop())
        flush(live)
        void live.audio.close()
        live.captureActivity?.close()
        live.audioSession.restore()
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

    const drainRepair = (live: Live) => {
        if (!live.ready || !live.repair || live.responding || live.draftTurns.hasPending()) return
        const request = live.repair
        live.repair = null
        live.awaitingDraft = true
        setDraftIssue(null)
        patch({ drafting: true })
        report('draft retry', `explicit=${request.explicit} segments=${request.texts.length}`)
        tellOmni(live, `请根据下列本次待处理原话完成草稿编辑并调用 update_draft，返回完整正文和待处理列表。${request.explicit ? '用户明确要求纳入这些原话。' : '此前整理因技术原因失败，请重试。普通补充加入正文，明确纠错只修改对应内容，不追加纠正要求本身。'}\n本次待处理原话：\n${request.texts.join('\n')}`, false)
        respond(live, false)
    }

    const queueRepair = (live: Live, texts: string[], explicit: boolean) => {
        live.repair = { texts: [...new Set([...(live.repair?.texts ?? []), ...texts])], explicit: explicit || Boolean(live.repair?.explicit) }
    }

    const retainUnprocessedSpeech = (live: Live, text: string | undefined) => {
        if (!text) return false
        if (optionsRef.current.target === 'terminal') {
            setDraftIssue({ reason: 'invalidDraft' })
            return false
        }
        deferredRef.current = [...deferredRef.current, { text, reason: '', status: 'unprocessed' }]
        setDeferred(deferredRef.current)
        queueRepair(live, [text], false)
        setDraftIssue(null)
        return true
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
                if (live.draftDismissed && !live.micWanted) break
                live.draftDismissed = false
                optionsRef.current.onSpeechStart?.()
                setSilenceSince(null)
                live.speechItemId = typeof event.item_id === 'string' ? event.item_id : undefined
                if (live.speechItemId) {
                    live.speechLevels.set(live.speechItemId, live.latestRms)
                    if (isMediaPlaybackActive()) live.echoItems.add(live.speechItemId)
                }
                if (live.speechLevels.size > 64) live.speechLevels.delete(live.speechLevels.keys().next().value!)
                live.draftTurns.start(typeof event.item_id === 'string' ? event.item_id : undefined, draftRef.current)
                live.awaitingDraft = true
                setDraftIssue(null)
                live.stats.speechStarts += 1
                flush(live)
                live.lastActivity = Date.now()
                patch({ hearing: true, playing: false })
                break
            case 'input_audio_buffer.speech_stopped':
                if (live.draftDismissed) break
                live.speechItemId = undefined
                live.draftTurns.stop(typeof event.item_id === 'string' ? event.item_id : undefined)
                setSilenceSince(Date.now())
                patch({ hearing: false, drafting: true })
                break
            case 'response.created':
                live.responding = true
                live.audible = live.requested.shift() ?? false
                if (!live.audible) live.draftTurns.response((event.response as { id?: string } | undefined)?.id)
                break
            case 'response.done': {
                const response = event.response as { id?: string; status?: string; output?: Array<{ type?: string; call_id?: string }> } | undefined
                for (const item of response?.output ?? []) {
                    if (item.type !== 'function_call' || !item.call_id) continue
                    const call = live.pendingCalls.get(item.call_id)
                    if (!call || (call.responseId && call.responseId !== response?.id)) continue
                    if (response?.status === 'completed') send(live, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: call.output } })
                    live.pendingCalls.delete(item.call_id)
                }
                for (const [id, call] of live.pendingCalls) {
                    if (call.responseId === response?.id) live.pendingCalls.delete(id)
                }
                const summary = live.draftTurns.summary(response?.id)
                report('draft response', `status=${response?.status ?? 'unknown'} segments=${summary.segments} transcribed=${summary.transcribed} handled=${summary.handled} pending=${live.draftTurns.hasPending()}`)
                const completedItem = live.draftTurns.itemId(response?.id)
                setTranscription((current) => current?.itemId === completedItem ? null : current)
                const fallback = live.draftTurns.finish(response?.id)
                if (retainUnprocessedSpeech(live, fallback)) live.awaitingDraft = false
                if (live.awaitingDraft && !live.audible && !live.draftTurns.hasPending()) {
                    live.awaitingDraft = false
                    const response = event.response as { status?: string; status_details?: { error?: { message?: string } } } | undefined
                    const detail = response?.status_details?.error?.message
                    setDraftIssue({ reason: response?.status === 'failed' ? 'service' : 'noDraft', detail })
                }
                live.responding = false
                live.lastActivity = Date.now()
                patch({ drafting: live.draftTurns.hasPending() })
                if (live.wantResponse) {
                    live.wantResponse = false
                    const speak = live.queuedSpeak
                    live.queuedSpeak = false
                    respond(live, speak)
                }
                drainRepair(live)
                break
            }
            case 'conversation.item.input_audio_transcription.completed':
                if (live.draftDismissed) break
                if (typeof event.item_id === 'string' && typeof event.transcript === 'string') {
                    const transcript = event.transcript
                    live.echoItems.delete(event.item_id)
                    if (isPlaybackEcho(transcript, live.speechLevels.get(event.item_id))) {
                        const before = live.draftTurns.command(event.item_id)
                        if (before !== undefined && live.lastDraftItemId === event.item_id) {
                            draftRef.current = before
                            setDraft(before)
                        }
                        setTranscription(current => current?.itemId === event.item_id ? null : current)
                        live.awaitingDraft = false
                        setSilenceSince(null)
                        report('playback echo filtered', `chars=${transcript.length}`)
                        break
                    }
                    setRecentSpeech((current) => [...current, transcript].slice(-24))
                    const ui = optionsRef.current.onUiControl ? spokenUiControl(transcript, Boolean(optionsRef.current.selectingSession)) : null
                    if (ui) {
                        if (live.uiItems.has(event.item_id)) break
                        live.uiItems.add(event.item_id)
                        const before = live.draftTurns.command(event.item_id)
                        if (before !== undefined) {
                            draftRef.current = before
                            setDraft(before)
                            setSilenceSince(null)
                            setTranscription(null)
                            live.awaitingDraft = false
                            optionsRef.current.onUiControl?.(ui)
                        }
                        break
                    }
                    const key = spokenTerminalKey(event.transcript)
                    const specialKey = optionsRef.current.target === 'terminal' || key === 'interrupt' ? key : null
                    const command = specialKey ?? voiceDraftCommand(event.transcript)
                    if (command) {
                        const before = live.draftTurns.command(event.item_id)
                        if (before !== undefined) {
                            live.awaitingDraft = false
                            setSilenceSince(null)
                            setTranscription(null)
                            voiceCommandRef.current(command, before)
                            if (live.draftTurns.isFinished(event.item_id)) drainRepair(live)
                        }
                    } else {
                        if (!live.draftTurns.isHandled(event.item_id)) setTranscription({ itemId: event.item_id, text: event.transcript })
                        if (retainUnprocessedSpeech(live, live.draftTurns.transcript(event.item_id, event.transcript))) setTranscription(null)
                    }
                    if (!command) drainRepair(live)
                }
                break
            case 'conversation.item.input_audio_transcription.failed': {
                if (typeof event.item_id === 'string') live.echoItems.delete(event.item_id)
                if (live.draftDismissed) break
                const detail = (event.error as { message?: string } | undefined)?.message
                live.awaitingDraft = false
                setDraftIssue({ reason: 'service', detail })
                patch({ hearing: false, drafting: false })
                break
            }
            case 'response.audio.delta':
                if (live.audible) play(live, fromBase64(String(event.delta)))
                break
            case 'response.audio_transcript.done':
                if (live.audible) say('bot', String(event.transcript ?? ''))
                break
            case 'response.function_call_arguments.done': {
                const callId = typeof event.call_id === 'string' && event.call_id ? event.call_id : undefined
                if (callId && live.handledCalls.has(callId)) break
                if (callId) {
                    live.handledCalls.add(callId)
                    if (live.handledCalls.size > 256) live.handledCalls.delete(live.handledCalls.values().next().value!)
                }
                let output = JSON.stringify({ error: '未知操作' })
                if (live.draftDismissed || live.draftTurns.isCommand(typeof event.response_id === 'string' ? event.response_id : undefined)) {
                    output = JSON.stringify({ ignored: true, reason: '该操作已由客户端处理' })
                } else if (event.name === 'control_ui' && optionsRef.current.onUiControl) {
                    try {
                        const responseId = typeof event.response_id === 'string' ? event.response_id : undefined
                        const itemId = live.draftTurns.itemId(responseId)
                        live.draftTurns.handled(responseId)
                        live.awaitingDraft = false
                        setSilenceSince(null)
                        setTranscription(null)
                        const generation = live.connectionGen
                        let lookup = false
                        output = JSON.stringify(executeFrontendCommand(JSON.parse(String(event.arguments || '{}')), control => {
                            if (itemId && live.uiItems.has(itemId)) return { ignored: true }
                            if (itemId) live.uiItems.add(itemId)
                            lookup = control.action === 'list_sessions' && Boolean(control.query)
                            return optionsRef.current.onUiControl?.(control)
                        }))
                        if (generation !== live.connectionGen) return
                        if (lookup) live.wantResponse = true
                    } catch (error) { output = JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid frontend command', hint: 'Use help for available commands.' }) }
                } else if (event.name === 'update_draft') {
                    try {
                        const { text, alternatives, deferred: nextDeferred, corrections: nextCorrections } = draftUpdateSchema.parse(JSON.parse(String(event.arguments || '{}')))
                        if (optionsRef.current.target !== 'terminal' && draftLanguageRef.current !== 'original' && alternativesEnabledRef.current && text.trim()
                            && (!alternatives || new Set(alternatives.filter(candidate => candidate !== text.trim())).size < 2)) {
                            throw new Error('Translation requires at least two distinct alternatives')
                        }
                        if (nextCorrections?.length) {
                            const sessionId = optionsRef.current.sessionId
                            setCorrections(previous => ({ ...previous, [sessionId]: mergeVoiceCorrections(previous[sessionId] ?? [], nextCorrections) }))
                        }
                        if (nextDeferred && optionsRef.current.target !== 'terminal') { deferredRef.current = nextDeferred; setDeferred(nextDeferred) }
                        if (optionsRef.current.target === 'terminal' && text.trim()) terminalVoiceInput(text, false)
                        const responseId = typeof event.response_id === 'string' ? event.response_id : undefined
                        live.draftTurns.handled(responseId)
                        const itemId = live.draftTurns.itemId(responseId)
                        setTranscription((current) => !responseId || current?.itemId === itemId ? null : current)
                        live.lastDraftItemId = itemId
                        report('draft update', `chars=${text.trim().length} changed=${text.trim() !== draftRef.current.trim()}`)
                        draftRef.current = text.trim()
                        setDraft(text.trim())
                        setTranslations(optionsRef.current.target !== 'terminal' && draftLanguageRef.current !== 'original' && alternativesEnabledRef.current && text.trim() && alternatives
                            ? { text: text.trim(), language: draftLanguageRef.current, sessionId: optionsRef.current.sessionId,
                                alternatives: [...new Set(alternatives)].filter(candidate => candidate !== text.trim()) }
                            : null)
                        output = JSON.stringify({ saved: true })
                        setDraftIssue(null)
                        live.awaitingDraft = false
                    } catch {
                        live.awaitingDraft = false
                        setDraftIssue({ reason: 'invalidDraft' })
                        output = JSON.stringify({ error: '草稿参数无效' })
                    }
                }
                // Acknowledge only calls present in the completed response, after the server commits them.
                if (callId) live.pendingCalls.set(callId, { responseId: typeof event.response_id === 'string' ? event.response_id : undefined, output })
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
                    if (live.awaitingDraft) {
                        live.awaitingDraft = false
                        setDraftIssue({ reason: 'service', detail: message || undefined })
                        patch({ hearing: false, drafting: false })
                    }
                    console.warn('[omni]', message)
                }
                break
            }
        }
    }, [patch, say])

    /** Opens the Omni session (again after DashScope ends one: sessions are time limited). */
    const connect = useCallback(async (live: Live) => {
        const { api, baseUrl, token, sessionId } = optionsRef.current
        if (!sessionId) return stop()
        if (!api) return stop('notConfigured')
        if (live.awaitingDraft) {
            live.awaitingDraft = false
            setDraftIssue({ reason: 'interrupted' })
        }
        live.pendingCalls.clear()
        live.handledCalls.clear()
        live.uiItems.clear()
        live.draftTurns.clear()
        live.speechLevels.clear()
        live.echoItems.clear()
        live.speechItemId = undefined
        live.lastDraftItemId = undefined
        live.repair = null
        setSilenceSince(null)
        setTranscription(null)
        const generation = ++live.connectionGen
        live.ready = false
        live.transport?.close()
        live.transport = undefined
        patch({ ready: false, hearing: false, drafting: false })
        let info
        try {
            info = await api.getOmniVoiceSession(sessionId)
        } catch (error) {
            if (liveRef.current === live && generation === live.connectionGen) {
                stop(error instanceof Error && error.message.includes('notConfigured') ? 'notConfigured' : String(error))
            }
            return
        }
        if (liveRef.current !== live || generation !== live.connectionGen) return
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
            onEvent: (event) => {
                if (generation === live.connectionGen) onEvent(live, event)
            },
            onClose: () => {
                if (liveRef.current !== live || live.transport !== transport) return
                report('omni closed', `ready=${live.ready}`)
                if (live.ready) void connect(live)
                else stop('Omni connection failed')
            }
        })
        live.transport = transport
        debugContext.current = new VoiceContextDebug(optionsRef.current.sessionId)
        live.instructions = optionsRef.current.target === 'terminal'
            ? terminalVoiceInstructions(info.title)
            : voiceDraftInstructions(info.title)
        if (optionsRef.current.onUiControl) live.instructions += `\n${VOICE_UI_INSTRUCTIONS}`
        send(live, {
            type: 'session.update',
            session: {
                modalities: ['text'],
                tool_choice: 'required',
                voice: VOICE,
                instructions: buildVoiceDraftContext(live.instructions, draftRef.current, frontendConversation(), deferredRef.current, correctionsRef.current[optionsRef.current.sessionId] ?? [], optionsRef.current.target === 'terminal' ? null : draftLanguageRef.current, alternativesEnabledRef.current),
                tools: [...(optionsRef.current.target === 'terminal' ? VOICE_DRAFT_TOOLS.map((tool) => ({ ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, required: ['text'] } } })) : VOICE_DRAFT_TOOLS), ...(optionsRef.current.onUiControl ? [VOICE_UI_TOOL] : [])],
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm24',
                input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
                turn_detection: { type: 'server_vad', threshold: getVoiceThreshold(), prefix_padding_ms: 300, silence_duration_ms: 500 }
            }
        })
    }, [onEvent, patch, stop])

    // Stopping the tracks is not enough: the source then feeds silence and the worklet keeps posting frames,
    // which interleaved with a reopened mic's frames garbled what Omni heard. Unhook all of it.
    const releaseMic = (live: Live) => {
        live.micGen += 1
        live.opening = false
        live.captureActivity?.close()
        live.captureActivity = undefined
        live.stream?.getTracks().forEach((track) => track.stop())
        live.stream = undefined
        live.source?.disconnect()
        live.source = undefined
        if (live.node) {
            stopPcm16Worklet(live.node)
        }
        live.node = undefined
        level.current = 0
    }

    const deferMicRecovery = (live: Live) => {
        releaseMic(live)
        live.retryAt = Date.now() + micRecoveryDelay(live.recoveryAttempts)
        patch({ mic: false, recovering: true, hearing: false })
    }

    /** The orb is the mic switch: on opens the microphone; the conversation stays connected while it is off. */
    const micOn = useCallback(async (live: Live, recovering = false) => {
        releaseMic(live)
        const gen = live.micGen
        live.micWanted = true
        live.lastActivity = Date.now()
        live.lastFrameAt = Date.now()
        live.healthyFrames = 0
        if (!recovering) { live.recoveryAttempts = 0; live.retryAt = 0 }
        live.opening = true
        report('audio session', `mic=true type=${live.audioSession.type}`)
        patch({ mic: true, recovering })
        try {
            if (live.audio.state !== 'running') await resumeAudio(live.audio)
            if (live.micGen !== gen || liveRef.current !== live) return
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
            })
            if (live.micGen !== gen || liveRef.current !== live) {
                stream.getTracks().forEach((track) => track.stop())
                return
            }
            live.stream = stream
            live.captureActivity = createCaptureActivity()
            const node = await addPcm16Worklet(live.audio)
            if (live.micGen !== gen || liveRef.current !== live) {
                // Switched off (or reopened) meanwhile: this opening is void.
                stream.getTracks().forEach((track) => track.stop())
                stopPcm16Worklet(node)
                return
            }
            node.connect(live.captureSink)
            live.node = node
            live.lastFrameAt = Date.now()
            const gate = createMicrophoneGate()
            node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
                if (liveRef.current !== live || live.node !== node) return
                const frame = new Int16Array(event.data)
                const loud = rms(frame, 0x8000)
                live.latestRms = loud
                if (live.speechItemId) live.speechLevels.set(live.speechItemId, Math.max(live.speechLevels.get(live.speechItemId) ?? 0, loud))
                const suppressEcho = live.captureActivity?.frame(loud) ?? false
                live.lastFrameAt = Date.now()
                if (++live.healthyFrames === 20) {
                    const track = stream.getAudioTracks()[0]
                    if (live.audio.state === 'running' && track?.readyState === 'live' && !track.muted) {
                        live.recoveryAttempts = 0
                        live.retryAt = 0
                        patch({ recovering: false })
                    } else live.healthyFrames = 0
                }
                live.stats.frames += 1
                live.stats.maxRms = Math.max(live.stats.maxRms, loud)
                const playing = live.sources.size > 0
                if (!playing) level.current = Math.min(1, loud * 8)
                const filtered = suppressEcho || (playing && loud < ECHO_RMS) ? new ArrayBuffer(event.data.byteLength) : event.data
                const audio = toBase64(gate(filtered, filtered === event.data ? loud : 0, sensitivity.current))
                if (live.ready) send(live, { type: 'input_audio_buffer.append', audio })
                else if (live.pendingAudio.push(audio) > 60) live.pendingAudio.shift()
            }
            live.source = live.audio.createMediaStreamSource(stream)
            live.source.connect(node)
        } catch (error) {
            if (live.micGen !== gen || liveRef.current !== live) return
            const reason = error instanceof DOMException && error.name === 'NotAllowedError' ? 'micPermission' : String(error)
            report('mic failed', `${reason} recovering=${recovering} ctx=${live.audio.state}`)
            if ((recovering || live.ready) && reason !== 'micPermission') {
                live.recoveryAttempts = Math.max(1, live.recoveryAttempts)
                deferMicRecovery(live)
            } else {
                stop(reason)
            }
        } finally {
            if (liveRef.current === live && live.micGen === gen) live.opening = false
        }
    }, [patch, stop])

    const rebuildAudio = (live: Live) => {
        releaseMic(live)
        flush(live)
        void live.audio.close().catch(() => {})
        Object.assign(live, createAudioGraph())
        patch({ playing: false })
    }

    /** Preserve an unlocked context first; rebuild on repeated failure with bounded backoff. */
    const recoverMic = useCallback(async (live: Live, why: string) => {
        if (liveRef.current !== live || live.recovering || live.opening || !live.micWanted) return
        const generation = ++live.recoveryGen
        live.recovering = true
        const attempt = ++live.recoveryAttempts
        report('mic recover', `${why} attempt=${attempt}`)
        try {
            if (live.awaitingDraft) {
                live.awaitingDraft = false
                setDraftIssue({ reason: 'interrupted' })
                patch({ hearing: false, drafting: false })
            }
            if (live.audio.state === 'closed' || attempt % 2 === 0) rebuildAudio(live)
            await micOn(live, true)
        } catch (error) {
            if (liveRef.current !== live || live.recoveryGen !== generation) return
            report('audio rebuild failed', String(error))
            deferMicRecovery(live)
        } finally {
            if (liveRef.current === live && live.recoveryGen === generation) {
                live.recovering = false
                if (live.recoveryAttempts) live.retryAt = Math.max(live.retryAt, Date.now() + micRecoveryDelay(attempt))
            }
        }
    }, [micOn, patch])

    /** Off: no more listening, but what was already said still goes into the draft. */
    const micOff = useCallback((live: Live) => {
        live.recoveryGen++
        live.recovering = false
        live.retryAt = 0
        releaseMic(live)
        live.micWanted = false
        report('audio session', `mic=false type=${live.audioSession.type}`)
        patch({ mic: false, recovering: false, hearing: false })
        if (live.ready && !live.responding) {
            send(live, { type: 'input_audio_buffer.commit' })
            respond(live, false)
        }
    }, [patch])

    const start = useCallback(async () => {
        if (liveRef.current) return
        // Keep one automatic audio category throughout capture and playback.
        const audioSession = createVoiceAudioSession()
        // Created synchronously inside the tap, so iOS lets it play.
        const graph = createAudioGraph()
        void resumeAudio(graph.audio).catch(() => {})
        const live: Live = {
            ...graph, audioSession, connectionGen: 0, instructions: '', awaitingDraft: false, draftDismissed: false, repair: null, draftTurns: new OmniDraftTurns(), pendingCalls: new Map(), handledCalls: new Set(), uiItems: new Set(), sources: new Set(), nextTime: 0, ready: false, pendingAudio: [],
            responding: false, wantResponse: false, requested: [], queuedSpeak: false, audible: false, lastActivity: Date.now(),
            lastFrameAt: Date.now(), recovering: false, opening: false, recoveryGen: 0, recoveryAttempts: 0, retryAt: 0, healthyFrames: 0, speechLevels: new Map(), echoItems: new Set(), latestRms: 0, micWanted: false, micGen: 0, stats: { frames: 0, maxRms: 0, speechStarts: 0, since: Date.now() }
        }
        liveRef.current = live
        setFlags({ ...OFF, on: true, mic: true })
        live.idleTimer = setInterval(() => {
            if (document.visibilityState === 'hidden') return
            const f = flagsRef.current
            const now = Date.now()
            if (!f.working && !live.responding && now - live.lastActivity > IDLE_MS) return stop(f.mic ? 'idle' : undefined)
            if (!live.micWanted) return
            if (live.recovering && live.opening && now - live.lastFrameAt > 15000) {
                live.recoveryGen++
                live.recovering = false
                deferMicRecovery(live)
                return
            }
            if (live.recovering || live.opening || now < live.retryAt) return
            if (!live.stream || live.audio.state !== 'running') { void recoverMic(live, `capture unavailable ctx=${live.audio.state}`); return }
            const track = live.stream.getAudioTracks()[0]
            if (!track || track.readyState === 'ended') void recoverMic(live, 'track ended')
            else if (track.muted) void recoverMic(live, 'track muted')
            else if (now - live.lastFrameAt > 3000) void recoverMic(live, `no frames for ${now - live.lastFrameAt} ms, ctx=${live.audio.state}`)
            else if (now - live.stats.since > 60_000) {
                const { frames, maxRms, speechStarts } = live.stats
                report('heartbeat', `frames=${frames} maxRms=${maxRms.toFixed(3)} speechStarts=${speechStarts} ready=${live.ready} ctx=${live.audio.state} audioSession=${live.audioSession.type}`)
                live.stats = { frames: 0, maxRms: 0, speechStarts: 0, since: now }
            }
        }, 2000)
        await Promise.all([micOn(live), connect(live)])
    }, [connect, micOn, recoverMic, stop])

    useEffect(() => subscribeVoiceSensitivity(() => {
        sensitivity.current = getVoiceSensitivity()
        const live = liveRef.current
        if (!live?.transport) return
        send(live, {
            type: 'session.update',
            session: {
                turn_detection: { type: 'server_vad', threshold: getVoiceThreshold(), prefix_padding_ms: 300, silence_duration_ms: 500 }
            }
        })
    }), [])

    // Recreate capture and transport after backgrounding, even if their reported states still look healthy.
    useEffect(() => {
        if (!flags.on) return
        let wasHidden = document.visibilityState === 'hidden'
        const onVisible = () => {
            if (document.visibilityState === 'hidden') {
                wasHidden = true
                setSilenceSince(null)
                return
            }
            const live = liveRef.current
            if (document.visibilityState !== 'visible' || !live) return
            report('visible', `audioSession=${live.audioSession.type} ctx=${live.audio.state} track=${live.stream?.getAudioTracks()[0]?.readyState ?? 'none'}`)
            if (wasHidden) {
                wasHidden = false
                live.lastActivity = Date.now()
                if (live.micWanted) void recoverMic(live, 'foreground')
                else void live.audio.resume().catch(() => {})
                void connect(live)
            } else {
                void live.audio.resume().catch(() => {})
            }
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => document.removeEventListener('visibilitychange', onVisible)
    }, [flags.on, connect, recoverMic])

    useEffect(() => {
        if (!flags.on) return
        const refresh = () => {
            if (resetContext.current) return
            const state = getMessageWindowState(options.sessionId)
            setConversation(recentVoiceConversation([...state.messages, ...state.pending]))
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        refresh()
        const unsubscribe = subscribeMessageWindow(options.sessionId, () => {
            if (timer) return
            timer = setTimeout(() => { timer = undefined; refresh() }, 300)
        })
        return () => { clearTimeout(timer); unsubscribe() }
    }, [flags.on, options.sessionId])

    // Include fallback edits and explicit clears, not just tool output known to the model.
    useEffect(() => {
        const live = liveRef.current
        if (!live?.transport || !live.instructions) return
        send(live, { type: 'session.update', session: { instructions: buildVoiceDraftContext(live.instructions, draft, frontendConversation(), deferred, corrections[options.sessionId] ?? [], options.target === 'terminal' ? null : draftLanguage, alternativesEnabled) } })
    }, [draft, deferred, conversation, options.sessionId, corrections, draftLanguage, options.target, alternativesEnabled])

    // The reply's loudness drives the orb while it speaks.
    useEffect(() => {
        if (!flags.playing) return
        const live = liveRef.current
        if (!live) return
        const samples = new Float32Array(live.analyser.fftSize)
        let timer: ReturnType<typeof setInterval> | undefined
        const tick = () => {
            live.analyser.getFloatTimeDomainData(samples)
            level.current = Math.min(1, rms(samples, 1) * 5)
        }
        const sync = () => {
            clearInterval(timer)
            if (document.visibilityState !== 'hidden') timer = setInterval(tick, 50)
        }
        sync()
        document.addEventListener('visibilitychange', sync)
        return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', sync)
        }
    }, [flags.playing])

    // Keep capture alive while reconnecting the model to the newly selected session.
    useEffect(() => {
        if (previousSession.current === options.sessionId) return
        savedDrafts.current[targetRef.current] = draftRef.current
        savedSpeech.current[targetRef.current] = { deferred: deferredRef.current, speech: speechRef.current }
        sessionDrafts.current.set(previousSession.current, { drafts: savedDrafts.current, speech: savedSpeech.current })
        previousSession.current = options.sessionId
        const saved = sessionDrafts.current.get(options.sessionId)
        savedDrafts.current = saved?.drafts ?? { chat: '', terminal: '' }
        savedSpeech.current = saved?.speech ?? { chat: { deferred: [], speech: [] }, terminal: { deferred: [], speech: [] } }
        targetRef.current = target
        draftRef.current = savedDrafts.current[target]
        deferredRef.current = savedSpeech.current[target].deferred
        speechRef.current = savedSpeech.current[target].speech
        setDraft(draftRef.current)
        setDeferred(deferredRef.current)
        setRecentSpeech(speechRef.current)
        setConversation('')
        setTranscription(null)
        setDraftIssue(null)
        setSilenceSince(null)
        const live = liveRef.current
        if (live) { live.awaitingDraft = false; live.pendingAudio = []; void connect(live) }
    }, [options.sessionId, target, connect])

    useEffect(() => {
        if (targetRef.current === target) return
        savedSpeech.current[targetRef.current] = { deferred: deferredRef.current, speech: speechRef.current }
        setDeferred(savedSpeech.current[target].deferred)
        setRecentSpeech(savedSpeech.current[target].speech)
        deferredRef.current = savedSpeech.current[target].deferred
        speechRef.current = savedSpeech.current[target].speech
        savedDrafts.current[targetRef.current] = draftRef.current
        targetRef.current = target
        draftRef.current = savedDrafts.current[target]
        setDraft(draftRef.current)
        setTranscription(null)
        setDraftIssue(null)
        setSilenceSince(null)
        const live = liveRef.current
        if (live) void connect(live)
    }, [target, connect])

    useEffect(() => () => stop(), [stop])

    const toggle = useCallback(() => {
        const live = liveRef.current
        if (!live) void start()
        else if (live.micWanted) micOff(live)
        else void micOn(live)
    }, [micOff, micOn, start])

    const beginDraftEdit = useCallback(() => {
        setEditing(true)
        setSilenceSince(null)
        const live = liveRef.current
        if (live) {
            if (live.micWanted) micOff(live)
            live.draftDismissed = true
            live.awaitingDraft = false
            live.wantResponse = false
            live.repair = null
            live.draftTurns.discard()
        }
        patch({ hearing: false, drafting: false })
        setTranscription(null)
    }, [micOff, patch])

    const editDraft = useCallback((text: string) => {
        setTranslations(null)
        draftRef.current = text
        setDraft(text)
        setSilenceSince(null)
        setDraftIssue(null)
    }, [])

    const endDraftEdit = useCallback(() => setEditing(false), [])

    const clearDraft = useCallback(() => {
        deferredRef.current = []
        setDeferred([])
        speechRef.current = []
        setRecentSpeech([])
        patch({ hearing: false, drafting: false })
        draftRef.current = ''
        setSilenceSince(null)
        setDraft('')
        setTranscription(null)
        setDraftIssue(null)
        if (liveRef.current) {
            liveRef.current.awaitingDraft = false
            liveRef.current.draftDismissed = true
            liveRef.current.wantResponse = false
            liveRef.current.repair = null
            liveRef.current.draftTurns.discard()
            liveRef.current.echoItems.clear()
        }
        const live = liveRef.current
        if (live) tellOmni(live, '[草稿已清空]', false)
    }, [patch])

    const resetHistory = useCallback(() => {
        resetGeneration.current++
        resetContext.current = true
        correctionsRef.current = {}
        setCorrections({})
        clearDraft()
        sessionDrafts.current.clear()
        savedDrafts.current = { chat: '', terminal: '' }
        savedSpeech.current = { chat: { deferred: [], speech: [] }, terminal: { deferred: [], speech: [] } }
        setConversation('')
        setCaption(null)
        const live = liveRef.current
        if (live) {
            live.pendingAudio = []
            live.instructions = ''
            live.lastActivity = Date.now()
            void connect(live)
        }
    }, [clearDraft, connect])

    /** Sends the draft; AI read-aloud is owned independently by useAiReadback. */
    const sendDraft = useCallback(async (textOverride?: string, preserveTurns = false) => {
        const { api, sessionId } = optionsRef.current
        const generation = resetGeneration.current
        const text = (textOverride ?? draft).trim()
        if (!api || !text || sendingRef.current || targetRef.current !== (optionsRef.current.target ?? 'chat')) return
        if (optionsRef.current.target === 'terminal') {
            try {
                const input = terminalVoiceInput(text, getVoiceTerminalExecute())
                if (!optionsRef.current.writeTerminal?.(input)) throw new Error('terminalUnavailable')
                setSilenceSince(null)
                setDraft('')
                draftRef.current = ''
                savedDrafts.current.terminal = ''
                const live = liveRef.current
                if (live) { live.draftTurns.discard(); tellOmni(live, '[草稿已发送]', false) }
            } catch (error) { say('system', error instanceof Error ? error.message : 'terminalUnavailable') }
            return
        }
        sendingRef.current = true
        setSilenceSince(null)
        setSending(true)
        let target: string
        const body = `${SENT_TAG}\n${text}`
        const localId = makeClientSideId('local')
        try {
            target = await api.resumeSession(sessionId)
            // Shown in the chat at once, like a message sent from the composer.
            appendOptimisticMessage(target, optimisticUserMessage({ text: body, localId, createdAt: Date.now() }))
            try {
                await api.sendMessage(target, body, localId)
            } catch (error) {
                updateMessageStatus(target, localId, 'failed')
                throw error
            }
            updateMessageStatus(target, localId, 'sent')
        } catch (error) {
            say('system', error instanceof Error ? error.message : String(error))
            return
        } finally {
            sendingRef.current = false
            setSending(false)
        }
        if (optionsRef.current.sessionId !== sessionId || generation !== resetGeneration.current) return
        setRecentSpeech((current) => [...current, `[Sent to AI] ${text}`].slice(-24))
        const unchanged = draftRef.current.trim() === text
        if (unchanged) { draftRef.current = ''; setDraft('') }
        const live = liveRef.current
        if (!live) return
        if (!preserveTurns && unchanged && !flagsRef.current.hearing && !flagsRef.current.drafting) live.draftTurns.discard()
        tellOmni(live, unchanged ? '[草稿已发送]' : `[已发送的正文] ${JSON.stringify(text)}。发送期间草稿已更新，请保留当前草稿。`, false)

    }, [draft, patch, say])

    const pressKey = useCallback((key: TerminalKey) => {
        setSilenceSince(null)
        const current = optionsRef.current
        if (current.target === 'terminal') {
            if (!current.writeTerminal?.(TERMINAL_KEYS[key].sequence)) say('system', 'terminalUnavailable')
        } else if (key === 'interrupt') {
            void current.api?.interruptSession(current.sessionId).catch((error) => say('system', error instanceof Error ? error.message : 'Unable to interrupt'))
        }
    }, [say])

    const resolveSpeech = useCallback((index: number, include: boolean) => {
        const entry = deferredRef.current[index]
        if (!entry) return
        setSilenceSince(null)
        if (!include) {
            deferredRef.current = deferredRef.current.filter((_, i) => i !== index)
            setDeferred(deferredRef.current)
            const live = liveRef.current
            if (live?.repair) {
                live.repair.texts = live.repair.texts.filter((text) => text !== entry.text)
                if (!live.repair.texts.length) live.repair = null
            }
            setRecentSpeech((current) => [...current, `[Dismissed] ${entry.text}`].slice(-24))
            return
        }
        const live = liveRef.current
        if (!live?.ready) { setDraftIssue({ reason: 'interrupted' }); return }
        deferredRef.current = deferredRef.current.map((item, i) => i === index ? { ...item, status: 'unprocessed' } : item)
        setDeferred(deferredRef.current)
        live.draftDismissed = false
        setDraftIssue(null)
        queueRepair(live, [entry.text], true)
        drainRepair(live)
    }, [patch])

    voiceCommandRef.current = (command, before) => {
        setDraftIssue(null)
        if (command === 'clear') {
            clearDraft()
        } else if (command === 'pause') {
            setDraft(before)
            draftRef.current = before
            setSilenceSince(null)
        } else if (command === 'include') {
            setDraft(before)
            draftRef.current = before
            const entries = deferredRef.current.filter((entry) => voiceDraftCommand(entry.text) !== 'include')
            const unprocessed = entries.filter((entry) => entry.status === 'unprocessed')
            const selected = unprocessed.length ? unprocessed : entries.slice(-1)
            deferredRef.current = entries
            setDeferred(entries)
            const live = liveRef.current
            if (live && selected.length) {
                queueRepair(live, selected.map((entry) => entry.text), true)
            }
        } else if (command !== 'send') {
            setDraft(before)
            draftRef.current = before
            pressKey(command)
        } else {
            // Use the draft that preceded the command, even if a late model update included the command.
            setDraft(before)
            draftRef.current = before
            void sendDraft(before, true)
        }
    }

    useEffect(() => { if (options.autoSendBlocked) setSilenceSince(null) }, [options.autoSendBlocked])

    const autoSendSeconds = useVoiceAutoSend({
        silenceSince,
        ready: !editing && flags.mic && !liveRef.current?.echoItems.size && !options.autoSendBlocked && flags.on && flags.ready && !flags.hearing && !flags.drafting && !sending && !draftIssue && !transcription && !deferred.some((entry) => entry.status === 'unprocessed'),
        draft,
        send: sendDraft
    })

    return {
        getDebugContext: () => debugContext.current.snapshot(),
        state: deriveState(flags),
        /** Whether the microphone is on, whatever the conversation is doing (the orb shows it separately). */
        micOn: flags.on && flags.mic,
        micRecovering: flags.recovering,
        caption,
        level,
        toggle,
        draft,
        alternatives: alternativesEnabled && target === 'chat' && translations?.text === draft && translations.language === draftLanguage && translations.sessionId === options.sessionId
            ? translations.alternatives : [],
        editDraft,
        beginDraftEdit,
        endDraftEdit,
        draftIssue,
        deferred,
        resolveSpeech,
        transcription: transcription?.text ?? '',
        drafting: flags.drafting || flags.hearing,
        sending,
        autoSendSeconds: options.autoSendBlocked ? null : autoSendSeconds,
        sendDraft,
        pressKey,
        clearDraft,
        resetHistory
    }
}
