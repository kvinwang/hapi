import { useSyncExternalStore } from 'react'

export type VoiceDraftLanguage = 'original' | 'zh' | 'en'
export type VoicePanelMode = 'auto' | 'manual'
export const OPEN_VOICE_PANEL = 'hapi-open-voice-panel'
const KEY = 'hapi.voicePanelMode'
const ALTERNATIVES_KEY = 'hapi.voiceDraftAlternatives'
const LANGUAGE_KEY = 'hapi.voiceDraftLanguage'
const EVENT = 'hapi-voice-panel-settings'

function read(): VoicePanelMode {
    return localStorage.getItem(KEY) === 'manual' ? 'manual' : 'auto'
}

function readLanguage(): VoiceDraftLanguage {
    const value = localStorage.getItem(LANGUAGE_KEY)
    return value === 'zh' || value === 'en' ? value : 'original'
}

function readAlternatives(): boolean {
    return localStorage.getItem(ALTERNATIVES_KEY) !== 'false'
}

function subscribe(listener: () => void) {
    window.addEventListener(EVENT, listener)
    window.addEventListener('storage', listener)
    return () => {
        window.removeEventListener(EVENT, listener)
        window.removeEventListener('storage', listener)
    }
}

export function useVoicePanelSettings() {
    const mode = useSyncExternalStore(subscribe, read, () => 'auto' as const)
    const language = useSyncExternalStore(subscribe, readLanguage, () => 'original' as const)
    const alternativesEnabled = useSyncExternalStore(subscribe, readAlternatives, () => true)
    return {
        mode,
        alternativesEnabled,
        setAlternativesEnabled(value: boolean) {
            localStorage.setItem(ALTERNATIVES_KEY, String(value))
            window.dispatchEvent(new Event(EVENT))
        },
        language,
        setLanguage(value: VoiceDraftLanguage) {
            localStorage.setItem(LANGUAGE_KEY, value)
            window.dispatchEvent(new Event(EVENT))
        },
        setMode(value: VoicePanelMode) {
            localStorage.setItem(KEY, value)
            window.dispatchEvent(new Event(EVENT))
        }
    }
}
