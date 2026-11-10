import type { ReadbackOutputState } from '@/lib/readbackOutput'
import type { SessionSummary, DecryptedMessage } from '@/types/api'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceApi } from '@/lib/voiceApi'
import { AiReadbackPlayer, aiReadbackText, latestAiTurn, userReadbackText } from '@/lib/aiReadback'
import { getMessageWindowState, subscribeMessageWindow, subscribeLiveMessages } from '@/lib/message-window-store'

import { useReadbackSettings } from './useReadbackSettings'
import { isReadbackTab, isSelectedReadbackConversation, useReadbackSelection, READBACK_STOP, READBACK_STOP_EVENT, stopReadbackEverywhere } from '@/lib/readbackSelection'

type Entry = { hub: string; player: AiReadbackPlayer | null; stop: () => void }

export function useAiReadback(options: { api: VoiceApi; sessionId: string; baseUrl: string; token: string; sessions?: SessionSummary[]; backgroundApi?: VoiceApi }) {
    const { enabled, setEnabled, language, setLanguage, ownMessages, setOwnMessages } = useReadbackSettings()
    const readOwn = useRef(ownMessages)
    readOwn.current = ownMessages
    const selection = useReadbackSelection(options.baseUrl, options.sessionId)
    const favoriteIds = (options.sessions ?? []).filter(session => session.favorite).map(session => session.id).sort().join(',')
    const favorites = useRef(new Set<string>())
    favorites.current = new Set(favoriteIds ? favoriteIds.split(',') : [])
    const entries = useRef(new Map<string, Entry>())
    const playingIds = useRef(new Set<string>())
    const currentLanguage = useRef(language)
    currentLanguage.current = language
    const current = useRef(options)
    current.current = options
    const allowed = (id: string) => isSelectedReadbackConversation(current.current.baseUrl, id)
        || (favorites.current.has(id) && (Boolean(navigator.locks) || isReadbackTab()))
    const [output, setOutput] = useState<ReadbackOutputState | null>(null)
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const replayRef = useRef<AiReadbackPlayer | null>(null)
    const replayGeneration = useRef(0)
    const playerRef = useRef<AiReadbackPlayer | null>(null)
    const audio = useRef<AudioContext | null>(null)
    useEffect(() => () => {
        replayGeneration.current++
        replayRef.current?.close()
        replayRef.current = null
    }, [options.sessionId, options.baseUrl, enabled])

    useEffect(() => {
        const targets = new Set(enabled ? [options.sessionId, ...favorites.current].filter(Boolean) : [])
        for (const [id, entry] of entries.current) {
            if (!targets.has(id) || entry.hub !== options.baseUrl) {
                entry.stop()
                entries.current.delete(id)
            } else if (!allowed(id) && entry.player) { entry.player.close(); entry.player = null }
        }
        if (!allowed(options.sessionId)) {
            replayGeneration.current++
            replayRef.current?.close()
            replayRef.current = null
        }
        if (!enabled) {
            setPlaying(false)
            setError(null)
            playerRef.current = null
            return
        }
        audio.current ??= new AudioContext()
        for (const sessionId of targets) {
            if (entries.current.has(sessionId)) continue
            let disposed = false
            let lastSeq: number | null = null
            const spoken = new Set<string>()
            let retry: ReturnType<typeof setTimeout> | undefined
            let unsubscribe: (() => void) | undefined
            const api = sessionId === options.sessionId ? options.api : options.backgroundApi ?? options.api
            const entry: Entry = { hub: options.baseUrl, player: null, stop: () => {} }
            const ensurePlayer = () => {
                if (entry.player) return entry.player
                const player = new AiReadbackPlayer({
                    api, sessionId, baseUrl: options.baseUrl, getToken: () => current.current.token,
                    getLanguage: () => currentLanguage.current, allowed: () => allowed(sessionId), audio: audio.current!,
                    onOutput: state => { if (!disposed) setOutput(state) },
                    onPlaying: value => {
                        if (disposed) return
                        if (value) playingIds.current.add(sessionId)
                        else playingIds.current.delete(sessionId)
                        setPlaying(playingIds.current.size > 0)
                    },
                    onError: message => { if (!disposed) setError(message) },
                    onReady: () => { if (!disposed) setError(null) }
                })
                entry.player = player
                if (sessionId === current.current.sessionId) playerRef.current = player
                void player.start()
                return player
            }
            const accept = (message: DecryptedMessage) => {
                if (disposed || !allowed(sessionId) || spoken.has(message.id)) return
                const reply = aiReadbackText(message)
                const text = reply ?? (readOwn.current ? userReadbackText(message) : null)
                if (!text) return
                spoken.add(message.id)
                if (spoken.size > 1000) spoken.delete(spoken.values().next().value!)
                ensurePlayer().enqueue(text, undefined, JSON.stringify([options.baseUrl, sessionId, message.id]), !reply)
            }
            const unsubscribeLive = subscribeLiveMessages(sessionId, accept)
            const consume = () => {
                if (disposed || lastSeq === null) return
                const state = getMessageWindowState(sessionId)
                for (const message of [...state.messages, ...state.pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
                    if (message.seq === null || message.seq <= lastSeq) continue
                    lastSeq = message.seq
                    accept(message)
                }
            }
            const subscribe = async () => {
                try {
                    const snapshot = await api.getMessages(sessionId, { limit: 1 })
                    if (disposed) return
                    lastSeq = Math.max(0, ...snapshot.messages.map(message => message.seq ?? 0))
                    unsubscribe = subscribeMessageWindow(sessionId, consume)
                    consume()
                } catch {
                    if (!disposed) retry = setTimeout(() => { void subscribe() }, 5000)
                }
            }
            entry.stop = () => {
                disposed = true
                clearTimeout(retry)
                unsubscribeLive()
                unsubscribe?.()
                entry.player?.close()
                playingIds.current.delete(sessionId)
                setPlaying(playingIds.current.size > 0)
            }
            entries.current.set(sessionId, entry)
            void subscribe()
            if (sessionId === options.sessionId && allowed(sessionId)) ensurePlayer()
        }
        playerRef.current = entries.current.get(options.sessionId)?.player ?? null
    }, [enabled, options.sessionId, options.baseUrl, favoriteIds, selection])

    useEffect(() => {
        const resume = () => { if (audio.current?.state === 'suspended') void audio.current.resume().catch(() => {}) }
        document.addEventListener('pointerdown', resume, true)
        document.addEventListener('visibilitychange', resume)
        return () => {
            document.removeEventListener('pointerdown', resume, true)
            document.removeEventListener('visibilitychange', resume)
            for (const entry of entries.current.values()) entry.stop()
            entries.current.clear()
            void audio.current?.close().catch(() => {})
            audio.current = null
        }
    }, [])
    const toggle = useCallback(() => {
        if (!enabled || !options.sessionId) {
            audio.current ??= new AudioContext()
            void audio.current.resume().catch(() => {})
        }
        setEnabled(!enabled)
    }, [enabled])
    const stopLocal = useCallback(() => {
        replayGeneration.current++
        setError(null)
        replayRef.current?.close()
        replayRef.current = null
        for (const entry of entries.current.values()) entry.player?.interrupt()
    }, [])
    useEffect(() => {
        const storage = (event: StorageEvent) => { if (event.key === READBACK_STOP) stopLocal() }
        window.addEventListener('storage', storage)
        window.addEventListener(READBACK_STOP_EVENT, stopLocal)
        return () => {
            window.removeEventListener('storage', storage)
            window.removeEventListener(READBACK_STOP_EVENT, stopLocal)
        }
    }, [stopLocal])
    const interrupt = useCallback(stopReadbackEverywhere, [])
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
            const replay = new AiReadbackPlayer({
                api: selected.api, sessionId: selected.sessionId, baseUrl: selected.baseUrl, getToken: () => current.current.token, getLanguage: () => currentLanguage.current,
                allowed: () => allowed(selected.sessionId),
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
        void replayRef.current?.selectOutput(value)
        for (const entry of entries.current.values()) void entry.player?.selectOutput(value)
    }, [])
    return { enabled, playing, error, toggle, interrupt, setEnabled, replayLatest, output, selectOutput, language, setLanguage, ownMessages, setOwnMessages }
}
