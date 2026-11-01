import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { AiReadbackPlayer, aiReadbackText } from '@/lib/aiReadback'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'

export function useAiReadback(options: { api: ApiClient; sessionId: string; baseUrl: string; token: string }) {
    const [enabled, setEnabled] = useState(false)
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const current = useRef(options)
    current.current = options
    const player = useRef<AiReadbackPlayer | null>(null)
    const unsubscribe = useRef<(() => void) | null>(null)
    const stop = useCallback(() => {
        unsubscribe.current?.()
        unsubscribe.current = null
        player.current?.close()
        player.current = null
        setEnabled(false)
        setPlaying(false)
    }, [])

    useEffect(() => { stop(); setError(null); return stop }, [options.sessionId, stop])
    const toggle = useCallback(() => {
        if (player.current) { stop(); return }
        setError(null)
        const { sessionId } = current.current
        let lastSeq = 0
        const next = new AiReadbackPlayer({ ...current.current, onPlaying: setPlaying, onError: (message) => { stop(); setError(message) } })
        player.current = next
        setEnabled(true)
        const consume = () => {
            const latest = getMessageWindowState(sessionId)
            const messages = [...latest.messages, ...latest.pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            for (const message of messages) {
                if (message.seq === null || message.seq <= lastSeq) continue
                lastSeq = message.seq
                const text = aiReadbackText(message)
                if (text) next.enqueue(text)
            }
        }
        // Establish an authoritative sequence boundary, independent of phone/server clock skew.
        void current.current.api.getMessages(sessionId, { limit: 1 }).then((snapshot) => {
            if (player.current !== next) return
            lastSeq = Math.max(0, ...snapshot.messages.map((message) => message.seq ?? 0))
            unsubscribe.current = subscribeMessageWindow(sessionId, consume)
            consume()
        }).catch(() => { if (player.current === next) { stop(); setError('readback.error.start') } })
        void next.start()
    }, [stop])
    return { enabled, playing, error, toggle }
}
