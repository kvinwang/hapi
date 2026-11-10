import { useSyncExternalStore } from 'react'

const KEY = 'hapi.voiceVolume'
const EVENT = 'hapi-voice-volume'
export const VOICE_VOLUME_RANGE = { min: 50, max: 300, default: 150 } as const

export function getVoiceVolume(): number {
    const value = Number(localStorage.getItem(KEY) ?? NaN)
    return Number.isFinite(value) && value >= VOICE_VOLUME_RANGE.min && value <= VOICE_VOLUME_RANGE.max ? value : VOICE_VOLUME_RANGE.default
}

export function setVoiceVolume(value: number): void {
    if (!Number.isFinite(value)) return
    localStorage.setItem(KEY, String(Math.round(Math.max(VOICE_VOLUME_RANGE.min, Math.min(VOICE_VOLUME_RANGE.max, value)))))
    window.dispatchEvent(new Event(EVENT))
}

function subscribe(listener: () => void): () => void {
    window.addEventListener(EVENT, listener)
    window.addEventListener('storage', listener)
    return () => {
        window.removeEventListener(EVENT, listener)
        window.removeEventListener('storage', listener)
    }
}

export function useVoiceVolume(): number {
    return useSyncExternalStore(subscribe, getVoiceVolume, () => VOICE_VOLUME_RANGE.default)
}

/** Spoken output passes through the user's volume, then a limiter so boosts above 100% do not clip. */
export function createVoiceVolume(audio: BaseAudioContext) {
    const input = audio.createGain()
    const output = audio.createDynamicsCompressor()
    output.threshold.value = -3
    output.knee.value = 0
    output.ratio.value = 20
    output.attack.value = 0.003
    output.release.value = 0.1
    input.connect(output)
    const apply = () => { input.gain.value = getVoiceVolume() / 100 }
    apply()
    const close = subscribe(apply)
    audio.addEventListener('statechange', () => { if (audio.state === 'closed') close() })
    return { input, output, close }
}
