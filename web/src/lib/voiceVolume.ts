import { useSyncExternalStore } from 'react'

function numberSetting(key: string, range: { min: number; max: number; default: number }) {
    const event = `hapi-setting:${key}`
    const get = (): number => {
        const value = Number(localStorage.getItem(key) ?? NaN)
        return Number.isFinite(value) && value >= range.min && value <= range.max ? value : range.default
    }
    const set = (value: number): void => {
        if (!Number.isFinite(value)) return
        localStorage.setItem(key, String(Math.round(Math.max(range.min, Math.min(range.max, value)))))
        window.dispatchEvent(new Event(event))
    }
    const subscribe = (listener: () => void): () => void => {
        window.addEventListener(event, listener)
        window.addEventListener('storage', listener)
        return () => {
            window.removeEventListener(event, listener)
            window.removeEventListener('storage', listener)
        }
    }
    const use = (): number => useSyncExternalStore(subscribe, get, () => range.default)
    return { range, get, set, subscribe, use }
}

export const voiceVolume = numberSetting('hapi.voiceVolume', { min: 50, max: 300, default: 150 })

/** Mic level (dBFS) that counts as the user talking over readback and lowers it; 0 never triggers. */
export const voiceDuckThreshold = numberSetting('hapi.voiceDuckThreshold', { min: -50, max: 0, default: -38 })

/** Percentage of the readback volume kept while the user talks over it. */
export const voiceDuckLevel = numberSetting('hapi.voiceDuckLevel', { min: 0, max: 100, default: 25 })

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
    const apply = () => { input.gain.value = voiceVolume.get() / 100 }
    apply()
    const close = voiceVolume.subscribe(apply)
    audio.addEventListener('statechange', () => { if (audio.state === 'closed') close() })
    return { input, output, close }
}
