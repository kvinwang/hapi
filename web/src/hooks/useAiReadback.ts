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
        const state = getMessageWindowState(sessionId)
        // Existing history establishes the baseline; opening the reader must not replay it.
        let lastSeq = Math.max(0, state.newestSeq ?? 0, ...state.pending.map((message) => message.seq ?? 0))
        const startedAt = Date.now()
        const next = new AiReadbackPlayer({ ...current.current, onPlaying: setPlaying, onError: (message) => { stop(); setError(message) } })
        player.current = next
        setEnabled(true)
        unsubscribe.current = subscribeMessageWindow(sessionId, () => {
            const latest = getMessageWindowState(sessionId)
            const messages = [...latest.messages, ...latest.pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            for (const message of messages) {
                if (message.seq === null || message.seq <= lastSeq) continue
                lastSeq = message.seq
                if (message.createdAt < startedAt) continue
                const text = aiReadbackText(message)
                if (text) next.enqueue(text)
            }
        })
        void next.start()
    }, [stop])
    return { enabled, playing, error, toggle }
}
