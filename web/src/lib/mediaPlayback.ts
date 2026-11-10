import { voiceDuckThreshold } from './voiceVolume'

const captures = new Set<{ speaking: boolean }>()
const outputs = new Set<{ duck: (speaking: boolean) => void; text: string }>()
let echoes: Array<{ text: string; until: number }> = []
export const PLAYBACK_ECHO_RMS = 0.012

export function isMediaPlaybackActive(): boolean { return outputs.size > 0 }
function notify() {
    const speaking = [...captures].some(capture => capture.speaking)
    outputs.forEach(output => output.duck(speaking))
}

/** Local energy detection only controls ducking; the provider still owns transcription and turn detection. */
export function createCaptureActivity() {
    const capture = { speaking: false }
    captures.add(capture)
    let floor = 0.002
    let loudFrames = 0
    let lastLoud = 0
    let closed = false
    return {
        frame(rms: number, now = Date.now()): boolean {
            if (closed) return false
            const playing = isMediaPlaybackActive()
            const threshold = Math.max(playing ? 10 ** (voiceDuckThreshold.get() / 20) : 0.008, floor * (playing ? 4 : 3))
            if (rms >= threshold) { loudFrames++; lastLoud = now }
            else {
                loudFrames = 0
                if (!capture.speaking) floor = Math.max(0.0005, floor * 0.98 + rms * 0.02)
            }
            const speaking = loudFrames >= 3 || (capture.speaking && now - lastLoud < 800)
            if (speaking !== capture.speaking) { capture.speaking = speaking; notify() }
            return playing && rms < PLAYBACK_ECHO_RMS && !speaking
        },
        close() {
            if (closed) return
            closed = true
            captures.delete(capture)
            notify()
        }
    }
}

export function registerPlayback(duck: (speaking: boolean) => void) {
    const output = { duck, text: '' }
    outputs.add(output)
    notify()
    return {
        text(text: string) { output.text = text.slice(-4000) },
        release() {
            if (!outputs.delete(output)) return
            echoes = echoes.filter(entry => entry.until > Date.now())
            if (output.text) echoes.push({ text: output.text, until: Date.now() + 1500 })
            echoes = echoes.slice(-4)
        }
    }
}

/** Reject only quiet, long, near-verbatim copies of audio known to be playing (or its short echo tail). */
export function isPlaybackEcho(text: string, peakRms: number | undefined): boolean {
    if (peakRms === undefined || peakRms >= PLAYBACK_ECHO_RMS) return false
    const normalize = (value: string) => value.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
    const heard = normalize(text)
    if (heard.length < 8) return false
    echoes = echoes.filter(entry => entry.until > Date.now())
    return [...outputs, ...echoes].some(entry => {
        const spoken = normalize(entry.text)
        if (spoken.includes(heard)) return true
        const pairs = Array.from({ length: heard.length - 1 }, (_, i) => heard.slice(i, i + 2))
        return pairs.filter(pair => spoken.includes(pair)).length / pairs.length >= 0.9
    })
}
