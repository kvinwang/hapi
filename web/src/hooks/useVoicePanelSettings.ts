import { useSyncExternalStore } from 'react'

export type VoicePanelMode = 'auto' | 'manual'
export const OPEN_VOICE_PANEL = 'hapi-open-voice-panel'
const KEY = 'hapi.voicePanelMode'
const EVENT = 'hapi-voice-panel-settings'

function read(): VoicePanelMode {
    return localStorage.getItem(KEY) === 'manual' ? 'manual' : 'auto'
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
    return {
        mode,
        setMode(value: VoicePanelMode) {
            localStorage.setItem(KEY, value)
            window.dispatchEvent(new Event(EVENT))
        }
    }
}
