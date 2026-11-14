import { useSyncExternalStore } from 'react'

const ENVIRONMENT_KEY = 'hapi.voiceEnvironment'

/** Default sensitivity per place: a noisy one (restaurant) needs a higher bar so bystanders are not drafted. */
export const VOICE_ENVIRONMENTS = { normal: 50, noisy: 30, 'very-noisy': 15 } as const
export type VoiceEnvironment = keyof typeof VOICE_ENVIRONMENTS

export function getVoiceEnvironment(): VoiceEnvironment {
    const stored = localStorage.getItem(ENVIRONMENT_KEY)
    return stored && stored in VOICE_ENVIRONMENTS ? stored as VoiceEnvironment : 'normal'
}

export function setVoiceEnvironment(value: VoiceEnvironment): void {
    localStorage.setItem(ENVIRONMENT_KEY, value)
    localStorage.removeItem(SENSITIVITY_KEY)
    window.dispatchEvent(new Event(SENSITIVITY_EVENT))
}

const SENSITIVITY_KEY = 'hapi.voiceSensitivity'
const SENSITIVITY_EVENT = 'hapi-voice-sensitivity'

export function getVoiceSensitivity(): number {
    const stored = localStorage.getItem(SENSITIVITY_KEY)
    const value = stored === null ? NaN : Number(stored)
    return Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : VOICE_ENVIRONMENTS[getVoiceEnvironment()]
}

/** Server VAD speech probability; kept within 0.3–0.7 where it still tells speech from noise. */
export function getVoiceThreshold(): number {
    return Math.round(70 - getVoiceSensitivity() * 0.4) / 100
}

export function setVoiceSensitivity(value: number): void {
    if (!Number.isFinite(value)) return
    localStorage.setItem(SENSITIVITY_KEY, String(Math.round(Math.max(0, Math.min(100, value)))))
    window.dispatchEvent(new Event(SENSITIVITY_EVENT))
}

export function subscribeVoiceSensitivity(listener: () => void): () => void {
    window.addEventListener(SENSITIVITY_EVENT, listener)
    window.addEventListener('storage', listener)
    return () => {
        window.removeEventListener(SENSITIVITY_EVENT, listener)
        window.removeEventListener('storage', listener)
    }
}

export function useVoiceSensitivity(): number {
    return useSyncExternalStore(subscribeVoiceSensitivity, getVoiceSensitivity, () => 50)
}
