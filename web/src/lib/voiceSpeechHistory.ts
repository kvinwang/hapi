import { useSyncExternalStore } from 'react'

export type SpokenEntry = { at: number; text: string }

const PREFIX = 'hapi.voiceSpeech.'
const EVENT = 'hapi-voice-speech'
const LIMIT = 200
const EMPTY: SpokenEntry[] = []
const cache = new Map<string, { raw: string; entries: SpokenEntry[] }>()

function read(sessionId: string): SpokenEntry[] {
    let raw: string | null = null
    try { raw = localStorage.getItem(PREFIX + sessionId) } catch { return EMPTY }
    if (!raw) return EMPTY
    const cached = cache.get(sessionId)
    if (cached?.raw === raw) return cached.entries
    let entries: SpokenEntry[]
    try { entries = JSON.parse(raw) as SpokenEntry[] } catch { entries = EMPTY }
    cache.set(sessionId, { raw, entries })
    return entries
}

function write(sessionId: string, entries: SpokenEntry[]) {
    try {
        if (entries.length) localStorage.setItem(PREFIX + sessionId, JSON.stringify(entries))
        else localStorage.removeItem(PREFIX + sessionId)
    } catch { return }
    window.dispatchEvent(new Event(EVENT))
}

export function recordSpeech(sessionId: string, text: string, at = Date.now()) {
    const trimmed = text.trim()
    if (trimmed) write(sessionId, [...read(sessionId), { at, text: trimmed }].slice(-LIMIT))
}

export function clearSpeechHistory(sessionId: string) {
    write(sessionId, [])
}

function subscribe(listener: () => void) {
    window.addEventListener('storage', listener)
    window.addEventListener(EVENT, listener)
    return () => {
        window.removeEventListener('storage', listener)
        window.removeEventListener(EVENT, listener)
    }
}

export function useSpeechHistory(sessionId: string): SpokenEntry[] {
    return useSyncExternalStore(subscribe, () => read(sessionId), () => EMPTY)
}
