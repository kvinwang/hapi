import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'
import { isVoiceReadRepliesEnabled } from '@/components/VoiceOrb'

export type OmniVoiceState = 'off' | 'connecting' | 'listening' | 'hearing' | 'thinking' | 'working' | 'speaking' | 'error'

export type OmniCaption = { id: number; role: 'user' | 'bot' | 'system'; text: string }

type OmniEvent = { type: string; text?: string; on?: boolean; code?: string; message?: string }

type Flags = { on: boolean; ready: boolean; hearing: boolean; thinking: boolean; working: boolean; playing: boolean; error: boolean }

const OFF: Flags = { on: false, ready: false, hearing: false, thinking: false, working: false, playing: false, error: false }

/** While our own reply plays, quieter mic frames are sent as silence so the speaker's echo does not barge in. */
const ECHO_RMS = 0.012

function deriveState(f: Flags): OmniVoiceState {
    if (f.error) return 'error'
    if (!f.on) return 'off'
    if (!f.ready) return 'connecting'
    if (f.hearing) return 'hearing'
    if (f.playing) return 'speaking'
    if (f.working) return 'working'
    if (f.thinking) return 'thinking'
    return 'listening'
}

type Live = {
    socket: Socket
    audio: AudioContext
    output: GainNode
    analyser: AnalyserNode
    stream?: MediaStream
    sources: Set<AudioBufferSourceNode>
    nextTime: number
}

function rms(samples: ArrayLike<number>, scale: number): number {
    let sum = 0
    for (let i = 0; i < samples.length; i++) sum += (samples[i] / scale) ** 2
    return Math.sqrt(sum / Math.max(1, samples.length))
}

/**
 * Continuous voice conversation with the hub's Qwen Omni relay (`/omni`) about one session. `level` holds the
 * current loudness (0..1) of the mic while listening or of the reply while speaking, for the orb's animation.
 * Call `toggle` from a tap: iOS starts audio output only inside a user gesture.
 */
export function useOmniVoice(options: { baseUrl: string; token: string; sessionId: string }) {
    const [flags, setFlags] = useState<Flags>(OFF)
    const [caption, setCaption] = useState<OmniCaption | null>(null)
    const liveRef = useRef<Live | null>(null)
    const level = useRef(0)
    const sessionRef = useRef(options.sessionId)
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

    /** `note`: a code or message shown as a caption; anything but 'idle' (ended after a quiet spell) flashes the error state. */
    const stop = useCallback((note?: string) => {
        const live = liveRef.current
        if (!live) return
        liveRef.current = null
        live.socket.emit('omni:stop')
        live.socket.disconnect()
        live.stream?.getTracks().forEach((track) => track.stop())
        flush(live)
        void live.audio.close()
        level.current = 0
        if (note) say('system', note)
        const failed = Boolean(note) && note !== 'idle'
        setFlags(failed ? { ...OFF, error: true } : OFF)
        if (failed) setTimeout(() => setFlags((f) => (f.on ? f : OFF)), 1500)
    }, [say])

    const play = (live: Live, chunk: ArrayBuffer) => {
        const pcm = new Int16Array(chunk)
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
        patch({ playing: true, thinking: false })
    }

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
        const socket = io(`${options.baseUrl}/omni`, { auth: { token: options.token }, path: '/socket.io/' })
        const live: Live = { socket, audio, output, analyser, sources: new Set(), nextTime: 0 }
        liveRef.current = live
        setFlags({ ...OFF, on: true })

        socket.on('connect', () => socket.emit('omni:start', { sessionId: sessionRef.current, readReplies: isVoiceReadRepliesEnabled() }))
        socket.on('connect_error', (error) => stop(error.message))
        socket.on('omni:audio', (chunk: ArrayBuffer) => {
            if (liveRef.current === live) play(live, chunk)
        })
        socket.on('omni:event', (event: OmniEvent) => {
            if (liveRef.current !== live) return
            switch (event.type) {
                case 'ready': patch({ ready: true }); break
                case 'speech_started':
                    flush(live)
                    patch({ hearing: true, playing: false })
                    break
                case 'speech_stopped': patch({ hearing: false, thinking: true }); break
                case 'working': patch({ working: Boolean(event.on) }); break
                case 'done': patch({ thinking: false }); break
                case 'user': say('user', event.text ?? ''); break
                case 'bot': say('bot', event.text ?? ''); break
                case 'idle': stop('idle'); break
                case 'error': stop(event.code ?? event.message ?? 'error'); break
            }
        })

        try {
            live.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            })
            const node = await addPcm16Worklet(audio)
            node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
                if (liveRef.current !== live) return
                const frame = new Int16Array(event.data)
                const loud = rms(frame, 0x8000)
                const playing = live.sources.size > 0
                if (!playing) level.current = Math.min(1, loud * 8)
                socket.emit('omni:audio', playing && loud < ECHO_RMS ? new ArrayBuffer(event.data.byteLength) : event.data)
            }
            audio.createMediaStreamSource(live.stream).connect(node)
        } catch (error) {
            stop(error instanceof DOMException && error.name === 'NotAllowedError' ? 'micPermission' : String(error))
        }
    }, [options.baseUrl, options.token, patch, say, stop])

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

    // Following the user to another session re-targets the running conversation.
    useEffect(() => {
        sessionRef.current = options.sessionId
        const live = liveRef.current
        if (live?.socket.connected) {
            flush(live)
            setFlags((f) => ({ ...f, ready: false, hearing: false, thinking: false, working: false, playing: false }))
            live.socket.emit('omni:start', { sessionId: options.sessionId, readReplies: isVoiceReadRepliesEnabled() })
        }
    }, [options.sessionId])

    useEffect(() => () => stop(), [stop])

    const toggle = useCallback(() => {
        if (liveRef.current) stop()
        else void start()
    }, [start, stop])

    return { state: deriveState(flags), caption, level, toggle }
}
