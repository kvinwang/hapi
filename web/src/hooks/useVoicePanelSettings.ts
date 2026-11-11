import { useSyncExternalStore } from 'react'
import type { VoiceDraftModel } from '@/lib/providerDraftTransport'

export type VoiceDraftLanguage = 'original' | 'zh' | 'en'
export type VoicePanelMode = 'auto' | 'manual'
export const OPEN_VOICE_PANEL = 'hapi-open-voice-panel'
const KEY = 'hapi.voicePanelMode'
const ALTERNATIVES_KEY = 'hapi.voiceDraftAlternatives'
const LANGUAGE_KEY = 'hapi.voiceDraftLanguage'
const MODEL_KEY = 'hapi.voiceDraftModel'
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

/** Serialized for useSyncExternalStore, which needs a stable snapshot; null keeps drafting on Omni. */
function readModelKey(): string {
    return localStorage.getItem(MODEL_KEY) ?? ''
}

export function parseVoiceDraftModel(value: string): VoiceDraftModel | null {
    try {
        const parsed = JSON.parse(value) as Partial<VoiceDraftModel>
        return parsed.credentialId && parsed.model ? { credentialId: parsed.credentialId, model: parsed.model } : null
    } catch {
        return null
    }
}

export function getVoiceDraftModel(): VoiceDraftModel | null {
    return parseVoiceDraftModel(readModelKey())
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
    const draftModelKey = useSyncExternalStore(subscribe, readModelKey, () => '')
    return {
        mode,
        draftModel: parseVoiceDraftModel(draftModelKey),
        setDraftModel(value: VoiceDraftModel | null) {
            if (value) localStorage.setItem(MODEL_KEY, JSON.stringify(value))
            else localStorage.removeItem(MODEL_KEY)
            window.dispatchEvent(new Event(EVENT))
        },
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
