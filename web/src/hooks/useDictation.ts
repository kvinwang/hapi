import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping'

// Averages each 1/16000 s window of mic samples into a 16 kHz PCM16 frame, posted every 50 ms.
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
    constructor() { super(); this.step = sampleRate / 16000; this.pos = 0; this.sum = 0; this.count = 0; this.out = new Int16Array(800); this.n = 0 }
    process(inputs) {
        for (const sample of inputs[0]?.[0] ?? []) {
            this.sum += sample; this.count++
            if (++this.pos < this.step) continue
            this.pos -= this.step
            this.out[this.n++] = Math.max(-1, Math.min(1, this.sum / this.count)) * 0x7fff
            this.sum = 0; this.count = 0
            if (this.n === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(800); this.n = 0 }
        }
        return true
    }
}
registerProcessor('pcm16', Pcm16)`

type Recorder = { socket: Socket; stream?: MediaStream; audio?: AudioContext; live?: boolean }

/**
 * Streams the microphone to the hub's DashScope ASR relay. `onText` receives the whole transcript so far
 * (finished sentences plus the sentence being recognized) every time it changes.
 */
export function useDictation(options: {
    baseUrl: string
    token: string
    onText: (text: string) => void
    onError: (message: string) => void
}) {
    const [state, setState] = useState<DictationState>('idle')
    const recorderRef = useRef<Recorder | null>(null)
    const callbacksRef = useRef(options)
    callbacksRef.current = options

    const releaseMic = (recorder: Recorder) => {
        recorder.stream?.getTracks().forEach((track) => track.stop())
        void recorder.audio?.close()
    }

    const cleanup = useCallback((recorder: Recorder) => {
        releaseMic(recorder)
        recorder.socket.disconnect()
        if (recorderRef.current === recorder) {
            recorderRef.current = null
            setState('idle')
        }
    }, [])

    const start = useCallback(async () => {
        if (recorderRef.current) return
        const socket = io(`${options.baseUrl}/voice`, { auth: { token: options.token }, path: '/socket.io/' })
        const recorder: Recorder = { socket }
        recorderRef.current = recorder
        setState('starting')

        let finished = ''
        socket.on('voice:result', ({ text, final }: { text: string; final: boolean }) => {
            callbacksRef.current.onText(finished + text)
            if (final) finished += text
        })
        socket.on('voice:done', () => cleanup(recorder))
        const fail = (message: string) => {
            callbacksRef.current.onError(message)
            cleanup(recorder)
        }
        socket.on('voice:error', (error: { code?: string; message?: string }) =>
            fail(error.code ?? error.message ?? 'ASR failed'))
        socket.on('connect_error', (error) => fail(error.message))

        try {
            recorder.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            })
            recorder.audio = new AudioContext()
            const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
            await recorder.audio.audioWorklet.addModule(url)
            URL.revokeObjectURL(url)
            const node = new AudioWorkletNode(recorder.audio, 'pcm16')
            node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => socket.emit('voice:audio', event.data)
            recorder.audio.createMediaStreamSource(recorder.stream).connect(node)
        } catch (error) {
            fail(error instanceof DOMException && error.name === 'NotAllowedError' ? 'micPermission' : String(error))
            return
        }
        if (recorderRef.current !== recorder) {
            releaseMic(recorder)
            return
        }
        recorder.live = true
        socket.emit('voice:start')
        setState('recording')
    }, [cleanup, options.baseUrl, options.token])

    const stop = useCallback(() => {
        const recorder = recorderRef.current
        if (!recorder) return
        if (!recorder.live) {
            cleanup(recorder)
            return
        }
        releaseMic(recorder)
        recorder.socket.emit('voice:stop')
        setState('stopping')
        // The hub answers with voice:done once the last sentence is recognized.
        setTimeout(() => cleanup(recorder), 10_000)
    }, [cleanup])

    useEffect(() => () => {
        if (recorderRef.current) cleanup(recorderRef.current)
    }, [cleanup])

    return { state, start, stop }
}
