import type { ReadbackOutputState } from '@/lib/readbackOutput'
import type { DecryptedMessage } from '@/types/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { AiReadbackPlayer, aiReadbackText, latestAiTurn } from '@/lib/aiReadback'
import { getMessageWindowState, subscribeMessageWindow, subscribeLiveMessages } from '@/lib/message-window-store'

const ENABLED_KEY = 'hapi.aiReadbackEnabled'

export function useAiReadback(options: { api: ApiClient; sessionId: string; baseUrl: string; token: string }) {
    const [enabled, setEnabled] = useState(() => {
        try { return localStorage.getItem(ENABLED_KEY) === 'true' } catch { return false }
    })
    const [output, setOutput] = useState<ReadbackOutputState | null>(null)
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const replayRef = useRef<AiReadbackPlayer | null>(null)
    const replayGeneration = useRef(0)
    const playerRef = useRef<AiReadbackPlayer | null>(null)
    const audio = useRef<AudioContext | null>(null)
    const current = useRef(options)
    current.current = options

    useEffect(() => () => {
        replayGeneration.current++
        replayRef.current?.close()
        replayRef.current = null
    }, [options.sessionId, enabled])

    useEffect(() => {
        setPlaying(false)
        setError(null)
        if (!enabled || !options.sessionId) {
            void audio.current?.close().catch(() => {})
            audio.current = null
            return
        }
        audio.current ??= new AudioContext()
        let disposed = false
        let lastSeq: number | null = null
        const spoken = new Set<string>()
        let unsubscribe: (() => void) | undefined
        let retry: ReturnType<typeof setTimeout> | undefined
        const { api, sessionId } = current.current
        const report = (event: string, detail: string) => void api.reportVoiceEvent?.(`readback ${event}`, `session=${sessionId} ${detail}`).catch(() => {})
        const player = new AiReadbackPlayer({ ...current.current, audio: audio.current,
            onOutput: (state) => { if (!disposed) setOutput(state) },
            onPlaying: (value) => { if (!disposed) setPlaying(value) },
            onError: (message) => { if (!disposed) { setError(message); report('error', message) } },
            onReady: () => { if (!disposed) { setError(null); report('ready', `audio=${audio.current?.state}`) } }
        })
        playerRef.current = player
        const accept = (message: DecryptedMessage) => {
            if (disposed || spoken.has(message.id)) return
            const text = aiReadbackText(message)
            if (!text) return
            spoken.add(message.id)
            if (spoken.size > 1000) spoken.delete(spoken.values().next().value!)
            report('enqueue', `seq=${message.seq} chars=${text.length}`)
            player.enqueue(text)
        }
        const unsubscribeLive = subscribeLiveMessages(sessionId, accept)
        const consume = () => {
            if (disposed || lastSeq === null) return
            const latest = getMessageWindowState(sessionId)
            const messages = [...latest.messages, ...latest.pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            for (const message of messages) {
                if (message.seq === null || message.seq <= lastSeq) continue
                lastSeq = message.seq
                accept(message)
            }
        }
        const subscribe = async () => {
            try {
                const snapshot = await api.getMessages(sessionId, { limit: 1 })
                if (disposed) return
                lastSeq = Math.max(0, ...snapshot.messages.map((message) => message.seq ?? 0))
                unsubscribe = subscribeMessageWindow(sessionId, consume)
                consume()

            } catch {
                if (disposed) return
                setError('readback.error.start')
                retry = setTimeout(() => { void subscribe() }, 5000)
            }
        }
        void subscribe()
        void player.start()
        return () => { disposed = true; clearTimeout(retry); unsubscribeLive(); unsubscribe?.(); player.close(); if (playerRef.current === player) playerRef.current = null }
    }, [enabled, options.sessionId, options.baseUrl, options.token])

    useEffect(() => {
        try { localStorage.setItem(ENABLED_KEY, String(enabled)) } catch {}
    }, [enabled])
    useEffect(() => {
        const resume = () => { if (audio.current?.state === 'suspended') void audio.current.resume().catch(() => {}) }
        document.addEventListener('pointerdown', resume, true)
        document.addEventListener('visibilitychange', resume)
        return () => {
            document.removeEventListener('pointerdown', resume, true)
            document.removeEventListener('visibilitychange', resume)
            void audio.current?.close().catch(() => {})
            audio.current = null
        }
    }, [])
    const toggle = useCallback(() => {
        if (!enabled || !options.sessionId) {
            audio.current ??= new AudioContext()
            void audio.current.resume().catch(() => {})
        }
        setEnabled((value) => !value)
    }, [enabled])
    const interrupt = useCallback(() => {
        replayGeneration.current++
        setError(null)
        replayRef.current?.close()
        replayRef.current = null
        playerRef.current?.interrupt()
    }, [])
    const replayLatest = useCallback(async (focus?: string, question?: string, forward?: () => Promise<void>) => {
        const generation = ++replayGeneration.current
        const selected = current.current
        if (!selected.sessionId) return
        setError(null)
        try {
            const text = await latestAiTurn(selected.api, selected.sessionId)
            if (generation !== replayGeneration.current || selected.sessionId !== current.current.sessionId) return
            if (!text && !question) { setError('readback.error.noOutput'); return }
            if (!text && question && forward) { await forward(); return }
            replayRef.current?.close()
            replayRef.current = null
            if (playerRef.current) {
                playerRef.current.interrupt()
                if (question && forward) playerRef.current.answer(text, question, forward)
                else playerRef.current.enqueue(text, focus)
                return
            }
            const replay = new AiReadbackPlayer({ ...selected,
                onOutput: (state) => { if (generation === replayGeneration.current) setOutput(state) },
                onPlaying: (value) => {
                    if (replayRef.current !== replay) return
                    setPlaying(value)
                    if (!value) { replayRef.current = null; replay.close() }
                },
                onError: message => { if (generation === replayGeneration.current) setError(message) }
            })
            replayRef.current = replay
            if (question && forward) replay.answer(text, question, forward)
            else replay.enqueue(text, focus)
            void replay.start()
        } catch { if (generation === replayGeneration.current) setError('readback.error.start') }
    }, [])
    const selectOutput = useCallback((value: string) => {
        void (replayRef.current ?? playerRef.current)?.selectOutput(value)
    }, [])
    return { enabled, playing, error, toggle, interrupt, setEnabled, replayLatest, output, selectOutput }
}
