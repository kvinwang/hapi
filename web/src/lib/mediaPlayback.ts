import { createPlaybackAudioSession } from './voice-audio-session'

type Capture = { isSpeaking: () => boolean; pause: () => void; resume: () => void }
const captures = new Set<Capture>()
const listeners = new Set<() => void>()
let playbackUsers = 0
let route: ReturnType<typeof createPlaybackAudioSession> | null = null

export function mediaPlaybackType(): string { return route?.type ?? 'inactive' }
export function isMediaPlaybackActive(): boolean { return playbackUsers > 0 }
export function notifyCaptureChanged(): void { listeners.forEach((listener) => listener()) }

export function registerAudioCapture(capture: Capture): () => void {
    captures.add(capture)
    if (playbackUsers) capture.pause()
    notifyCaptureChanged()
    return () => { captures.delete(capture); notifyCaptureChanged() }
}

function waitUntil(test: () => boolean, signal: AbortSignal, quietMs = 0): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => { clearTimeout(timer); listeners.delete(check); signal.removeEventListener('abort', abort) }
        const finish = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(new DOMException('Playback cancelled', 'AbortError')) }
        const check = () => {
            if (signal.aborted) { abort(); return }
            if (!test()) { clearTimeout(timer); timer = undefined; return }
            if (!quietMs) finish()
            else if (timer === undefined) timer = setTimeout(finish, quietMs)
        }
        listeners.add(check)
        signal.addEventListener('abort', abort, { once: true })
        check()
    })
}

export function waitForMediaPlaybackEnd(signal: AbortSignal): Promise<void> {
    return waitUntil(() => playbackUsers === 0, signal)
}

/** Stop capture before selecting media playback; otherwise browsers may end the microphone track themselves. */
export async function acquireMediaPlayback(signal: AbortSignal): Promise<() => void> {
    await waitUntil(() => ![...captures].some((capture) => capture.isSpeaking()), signal, captures.size ? 500 : 0)
    if (signal.aborted) throw new DOMException('Playback cancelled', 'AbortError')
    if (playbackUsers++ === 0) {
        captures.forEach((capture) => capture.pause())
        route = createPlaybackAudioSession()
    }
    let released = false
    return () => {
        if (released) return
        released = true
        if (--playbackUsers === 0) {
            route?.restore()
            route = null
            captures.forEach((capture) => capture.resume())
            notifyCaptureChanged()
        }
    }
}
