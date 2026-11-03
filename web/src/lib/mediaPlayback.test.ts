import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaptureActivity, isMediaPlaybackActive, isPlaybackEcho, registerPlayback } from './mediaPlayback'
import { createVoiceAudioSession } from './voice-audio-session'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('continuous audio coordination', () => {
    it('ducks sustained speech, restores after silence, and does not alter capture ownership', () => {
        const capture = createCaptureActivity()
        const duck = vi.fn()
        const playback = registerPlayback(duck)
        expect(isMediaPlaybackActive()).toBe(true)
        expect(capture.frame(0.003, 0)).toBe(true)
        capture.frame(0.04, 50)
        capture.frame(0.04, 100)
        capture.frame(0.04, 150)
        expect(duck).toHaveBeenLastCalledWith(true)
        capture.frame(0.001, 700)
        expect(duck).toHaveBeenLastCalledWith(true)
        capture.frame(0.001, 1000)
        expect(duck).toHaveBeenLastCalledWith(false)
        playback.release()
        expect(capture.frame(0.003, 1100)).toBe(false)
        capture.close()
    })

    it('filters only quiet copies of actual readback, with a short echo tail', () => {
        vi.useFakeTimers()
        const playback = registerPlayback(vi.fn())
        playback.text('The microphone recovery tests all passed.')
        expect(isPlaybackEcho('The microphone recovery tests all passed.', 0.003)).toBe(true)
        expect(isPlaybackEcho('The microphone recovery tests all passed.', 0.04)).toBe(false)
        expect(isPlaybackEcho('Please explain the remaining problems.', 0.003)).toBe(false)
        expect(isPlaybackEcho('Stop', 0.003)).toBe(false)
        playback.release()
        expect(isPlaybackEcho('The microphone recovery tests all passed.', 0.003)).toBe(true)
        vi.advanceTimersByTime(1600)
        expect(isPlaybackEcho('The microphone recovery tests all passed.', 0.003)).toBe(false)
    })

    it('uses a stable automatic category across recording and playback lifetimes', () => {
        const changes: string[] = []
        let type = 'ambient'
        vi.stubGlobal('navigator', { audioSession: { get type() { return type }, set type(next: string) { type = next; changes.push(next) } } })
        const capture = createVoiceAudioSession()
        const playback = createVoiceAudioSession()
        expect(changes).toEqual(['auto'])
        capture.restore()
        expect(type).toBe('auto')
        playback.restore()
        expect(changes).toEqual(['auto', 'ambient'])
    })

    it('works without a browser audio-session API', () => {
        vi.stubGlobal('navigator', {})
        const route = createVoiceAudioSession()
        expect(route.type).toBe('unsupported')
        route.restore()
    })
})
