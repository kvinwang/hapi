import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireMediaPlayback, isMediaPlaybackActive, notifyCaptureChanged, registerAudioCapture } from './mediaPlayback'
import { createVoiceAudioSession } from './voice-audio-session'

const cleanup: Array<() => void> = []
let category: string
let changes: string[]
beforeEach(() => {
    vi.useFakeTimers()
    category = 'auto'
    changes = []
    vi.stubGlobal('navigator', { audioSession: { get type() { return category }, set type(value: string) { category = value; changes.push(value) } } })
})
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('media playback routing', () => {
    it('waits for speech to finish, stops capture before playback, and resumes after release', async () => {
        let speaking = true
        const captureRoute = createVoiceAudioSession()
        captureRoute.setMicrophoneActive(true)
        cleanup.push(captureRoute.restore)
        const pause = vi.fn(() => { changes.push('capture stopped'); captureRoute.setMicrophoneActive(false) })
        const resume = vi.fn(() => captureRoute.setMicrophoneActive(true))
        cleanup.push(registerAudioCapture({ isSpeaking: () => speaking, pause, resume }))
        const pending = acquireMediaPlayback(new AbortController().signal)
        await vi.advanceTimersByTimeAsync(1000)
        expect(pause).not.toHaveBeenCalled()
        speaking = false
        notifyCaptureChanged()
        await vi.advanceTimersByTimeAsync(499)
        expect(pause).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        const release = await pending
        cleanup.push(release)
        expect(category).toBe('playback')
        expect(changes.indexOf('capture stopped')).toBeLessThan(changes.indexOf('playback'))
        expect(isMediaPlaybackActive()).toBe(true)
        release()
        expect(resume).toHaveBeenCalledOnce()
        expect(category).toBe('play-and-record')
        expect(isMediaPlaybackActive()).toBe(false)
    })

    it('cancels a queued playback request without stopping the microphone', async () => {
        const pause = vi.fn()
        cleanup.push(registerAudioCapture({ isSpeaking: () => true, pause, resume: vi.fn() }))
        const controller = new AbortController()
        const pending = acquireMediaPlayback(controller.signal)
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(pause).not.toHaveBeenCalled()
        expect(isMediaPlaybackActive()).toBe(false)
    })

    it('keeps playback routing when a paused capture owner exits', async () => {
        const captureRoute = createVoiceAudioSession()
        captureRoute.setMicrophoneActive(true)
        const unregister = registerAudioCapture({ isSpeaking: () => false, pause: () => captureRoute.setMicrophoneActive(false), resume: vi.fn() })
        cleanup.push(unregister, captureRoute.restore)
        const pending = acquireMediaPlayback(new AbortController().signal)
        await vi.advanceTimersByTimeAsync(500)
        const release = await pending
        cleanup.push(release)
        unregister()
        captureRoute.restore()
        expect(category).toBe('playback')
        release()
        expect(category).toBe('auto')
    })

    it('still pauses capture in browsers without the Audio Session API', async () => {
        vi.stubGlobal('navigator', {})
        const pause = vi.fn()
        cleanup.push(registerAudioCapture({ isSpeaking: () => false, pause, resume: vi.fn() }))
        const pending = acquireMediaPlayback(new AbortController().signal)
        await vi.advanceTimersByTimeAsync(500)
        cleanup.push(await pending)
        expect(pause).toHaveBeenCalledOnce()
    })
})
