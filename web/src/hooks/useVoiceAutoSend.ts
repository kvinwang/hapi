import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

export type VoiceAutoSendDelay = number
const KEY = 'hapi.voiceAutoSend'
const EVENT = 'hapi-voice-auto-send'

function read(): string {
    try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}

function subscribe(callback: () => void) {
    window.addEventListener('storage', callback)
    window.addEventListener(EVENT, callback)
    return () => {
        window.removeEventListener('storage', callback)
        window.removeEventListener(EVENT, callback)
    }
}

export function useVoiceAutoSendSettings() {
    const stored = useSyncExternalStore(subscribe, read, () => '')
    let enabled = false
    let delay: VoiceAutoSendDelay = 3
    try {
        const value = JSON.parse(stored)
        enabled = value?.enabled === true
        if (Number.isInteger(value?.delay) && value.delay >= 1 && value.delay <= 60) delay = value.delay
    } catch { /* Use defaults for missing or invalid preferences. */ }
    const update = (next: { enabled: boolean; delay: VoiceAutoSendDelay }) => {
        try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { return }
        window.dispatchEvent(new Event(EVENT))
    }
    return { enabled, delay, update }
}

/** One attempt per speech pause; new speech, errors or disconnects cancel pending delivery. */
export function useVoiceAutoSend(options: {
    silenceSince: number | null
    ready: boolean
    draft: string
    send: () => Promise<void>
}) {
    const { enabled, delay } = useVoiceAutoSendSettings()
    const [remaining, setRemaining] = useState<number | null>(null)
    const attempted = useRef<number | null>(null)
    const send = useRef(options.send)
    send.current = options.send
    useEffect(() => {
        const pause = options.silenceSince
        if (!enabled || !options.ready || !options.draft.trim() || pause === null || attempted.current === pause) {
            setRemaining(null)
            return
        }
        const deadline = Date.now() + delay * 1000
        setRemaining(delay)
        const interval = setInterval(() => {
            setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
        }, 250)
        const timer = setTimeout(() => {
            clearInterval(interval)
            setRemaining(null)
            if (document.visibilityState === 'hidden') return
            attempted.current = pause
            void send.current().catch(() => {})
        }, delay * 1000)
        return () => {
            clearInterval(interval)
            clearTimeout(timer)
        }
    }, [enabled, delay, options.silenceSince, options.ready, options.draft])
    return remaining
}
