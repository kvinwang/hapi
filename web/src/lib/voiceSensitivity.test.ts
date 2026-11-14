import { beforeEach, expect, it, vi } from 'vitest'
import { getVoiceSensitivity, getVoiceThreshold, setVoiceEnvironment, setVoiceSensitivity, subscribeVoiceSensitivity } from './voiceSensitivity'

beforeEach(() => localStorage.clear())

it('maps lower sensitivity to a higher speech threshold and respects environment presets', () => {
    expect(getVoiceThreshold()).toBe(0.5)
    setVoiceSensitivity(15)
    expect(getVoiceSensitivity()).toBe(15)
    expect(getVoiceThreshold()).toBe(0.64)
    setVoiceEnvironment('noisy')
    expect(getVoiceSensitivity()).toBe(30)
    expect(getVoiceThreshold()).toBe(0.58)
})

it('bounds thresholds and ignores invalid saved sensitivity', () => {
    setVoiceSensitivity(100)
    expect(getVoiceThreshold()).toBe(0.3)
    setVoiceSensitivity(-1)
    expect(getVoiceThreshold()).toBe(0.7)
    localStorage.setItem('hapi.voiceSensitivity', 'invalid')
    expect(getVoiceSensitivity()).toBe(50)
})

it('notifies active listeners for slider, preset and cross-tab changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeVoiceSensitivity(listener)
    setVoiceSensitivity(20)
    setVoiceEnvironment('normal')
    window.dispatchEvent(new StorageEvent('storage'))
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
    setVoiceSensitivity(30)
    expect(listener).toHaveBeenCalledTimes(3)
})
