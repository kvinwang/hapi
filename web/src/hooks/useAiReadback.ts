import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { AiReadbackPlayer, aiReadbackText } from '@/lib/aiReadback'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'

const ENABLED_KEY = 'hapi.aiReadbackEnabled'

export function useAiReadback(options: { api: ApiClient; sessionId: string; baseUrl: string; token: string }) {
    const [enabled, setEnabled] = useState(() => {
        try { return localStorage.getItem(ENABLED_KEY) === 'true' } catch { return false }
    })
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const current = useRef(options)
    current.current = options

    useEffect(() => {
        setPlaying(false)
        setError(null)
        if (!enabled) return
        let disposed = false
        let lastSeq = 0
        let unsubscribe: (() => void) | undefined
        let retry: ReturnType<typeof setTimeout> | undefined
        const { api, sessionId } = current.current
        const player = new AiReadbackPlayer({ ...current.current,
            onPlaying: (value) => { if (!disposed) setPlaying(value) },
            onError: (message) => { if (!disposed) setError(message) },
            onReady: () => { if (!disposed) setError(null) }
        })
        const consume = () => {
            if (disposed) return
            const latest = getMessageWindowState(sessionId)
            const messages = [...latest.messages, ...latest.pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            for (const message of messages) {
                if (message.seq === null || message.seq <= lastSeq) continue
                lastSeq = message.seq
                const text = aiReadbackText(message)
                if (text) player.enqueue(text)
            }
        }
        const subscribe = async () => {
            try {
                const snapshot = await api.getMessages(sessionId, { limit: 1 })
                if (disposed) return
                lastSeq = Math.max(0, ...snapshot.messages.map((message) => message.seq ?? 0))
                unsubscribe = subscribeMessageWindow(sessionId, consume)
                consume()
                void player.start()
            } catch {
                if (disposed) return
                setError('readback.error.start')
                retry = setTimeout(() => { void subscribe() }, 5000)
            }
        }
        void subscribe()
        return () => { disposed = true; clearTimeout(retry); unsubscribe?.(); player.close() }
    }, [enabled, options.sessionId, options.baseUrl, options.token])

    useEffect(() => {
        try { localStorage.setItem(ENABLED_KEY, String(enabled)) } catch {}
    }, [enabled])
    const toggle = useCallback(() => setEnabled((value) => !value), [])
    return { enabled, playing, error, toggle }
}
