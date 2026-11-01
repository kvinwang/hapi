import { createVoiceAudioSession } from '@/lib/voice-audio-session'
import { notifyCaptureChanged, registerAudioCapture, waitForMediaPlaybackEnd } from '@/lib/mediaPlayback'
import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { addPcm16Worklet } from '@/lib/pcm16Worklet'

export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping'

type Recorder = { abort: AbortController; capturing: boolean; unregister?: () => void; route?: ReturnType<typeof createVoiceAudioSession>; socket: Socket; stream?: MediaStream; audio?: AudioContext; live?: boolean }

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
        recorder.route?.restore()
        recorder.capturing = false
        notifyCaptureChanged()
    }

    const cleanup = useCallback((recorder: Recorder) => {
        recorder.abort.abort()
        releaseMic(recorder)
        recorder.unregister?.()
        recorder.socket.disconnect()
        if (recorderRef.current === recorder) {
            recorderRef.current = null
            setState('idle')
        }
    }, [])

    const start = useCallback(async () => {
        if (recorderRef.current) return
        const socket = io(`${options.baseUrl}/voice`, { auth: { token: options.token }, path: '/socket.io/' })
        const recorder: Recorder = { socket, abort: new AbortController(), capturing: true }
        recorderRef.current = recorder
        setState('starting')
        recorder.unregister = registerAudioCapture({ isSpeaking: () => recorder.capturing, pause: () => {}, resume: () => {} })

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
            await waitForMediaPlaybackEnd(recorder.abort.signal)
            if (recorder.abort.signal.aborted) return
            recorder.route = createVoiceAudioSession()
            recorder.route.setMicrophoneActive(true)
            recorder.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            })
            if (recorder.abort.signal.aborted) { releaseMic(recorder); return }
            recorder.audio = new AudioContext()
            const node = await addPcm16Worklet(recorder.audio)
            node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => socket.emit('voice:audio', event.data)
            recorder.audio.createMediaStreamSource(recorder.stream).connect(node)
        } catch (error) {
            if (recorder.abort.signal.aborted) return
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
