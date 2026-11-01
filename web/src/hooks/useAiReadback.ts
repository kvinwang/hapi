import type { DecryptedMessage } from '@/types/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { AiReadbackPlayer, aiReadbackText } from '@/lib/aiReadback'
import { getMessageWindowState, subscribeMessageWindow, subscribeLiveMessages } from '@/lib/message-window-store'

const ENABLED_KEY = 'hapi.aiReadbackEnabled'

export function useAiReadback(options: { api: ApiClient; sessionId: string; baseUrl: string; token: string }) {
    const [enabled, setEnabled] = useState(() => {
        try { return localStorage.getItem(ENABLED_KEY) === 'true' } catch { return false }
    })
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const audio = useRef<AudioContext | null>(null)
    const current = useRef(options)
    current.current = options

    useEffect(() => {
        setPlaying(false)
        setError(null)
        if (!enabled) {
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
            onPlaying: (value) => { if (!disposed) setPlaying(value) },
            onError: (message) => { if (!disposed) { setError(message); report('error', message) } },
            onReady: () => { if (!disposed) { setError(null); report('ready', `audio=${audio.current?.state}`) } }
        })
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
        return () => { disposed = true; clearTimeout(retry); unsubscribeLive(); unsubscribe?.(); player.close() }
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
        if (!enabled) {
            audio.current ??= new AudioContext()
            void audio.current.resume().catch(() => {})
        }
        setEnabled((value) => !value)
    }, [enabled])
    return { enabled, playing, error, toggle }
}
