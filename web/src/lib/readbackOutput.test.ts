import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadbackOutput } from './readbackOutput'

const device = (deviceId: string, label: string): MediaDeviceInfo => ({ deviceId, label, groupId: '', kind: 'audiooutput', toJSON: () => ({}) })
const speaker = device('speaker-id', 'Built-in Speakers')
const headset = device('headset-id', 'Bluetooth Headset')
const routes: ReadbackOutput[] = []
afterEach(() => { routes.splice(0).forEach(route => route.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

function setup(devices = [headset, speaker]) {
    const mediaDevices = Object.assign(new EventTarget(), { enumerateDevices: vi.fn(async () => devices), selectAudioOutput: vi.fn(async () => speaker) })
    vi.stubGlobal('navigator', { mediaDevices })
    const audio = { destination: {}, setSinkId: vi.fn(async (_id: string) => {}) }
    const changed = vi.fn()
    const route = new ReadbackOutput(audio as unknown as AudioContext, changed)
    routes.push(route)
    return { route, audio, mediaDevices, changed }
}

describe('readback output routing', () => {
    it('prefers the built-in speaker over a headset without prompting or opening a microphone', async () => {
        const { route, audio, mediaDevices, changed } = setup()
        await route.refresh()
        expect(audio.setSinkId).toHaveBeenCalledExactlyOnceWith('speaker-id')
        expect(mediaDevices.selectAudioOutput).not.toHaveBeenCalled()
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'selected', label: speaker.label }))
        await route.refresh()
        expect(audio.setSinkId).toHaveBeenCalledOnce()
    })

    it.each([[], [headset], [device('default', 'Default - Speakers')], [device('unknown', '')]])('keeps system output when no physical speaker is identified: %j', async (...devices) => {
        const { route, audio, changed } = setup(devices)
        await route.refresh()
        expect(audio.setSinkId).toHaveBeenCalledWith('')
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable', label: null }))
    })

    it('handles denial and a disconnected selection without breaking playback', async () => {
        const { route, audio, mediaDevices, changed } = setup()
        audio.setSinkId.mockImplementation(async id => { if (id) throw new DOMException('Denied', 'NotAllowedError') })
        await route.refresh()
        expect(audio.setSinkId.mock.calls.map(([id]) => id)).toEqual(['speaker-id', ''])
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable' }))
        audio.setSinkId.mockResolvedValue()
        await route.select(headset.deviceId)
        expect(localStorage.getItem('hapi.readbackOutput')).toBe(headset.deviceId)
        mediaDevices.enumerateDevices.mockResolvedValue([speaker])
        mediaDevices.dispatchEvent(new Event('devicechange'))
        await route.refresh()
        expect(audio.setSinkId).toHaveBeenLastCalledWith('')
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable' }))
    })

    it('does not claim system fallback when changing the output also fails', async () => {
        const { route, audio, changed } = setup()
        audio.setSinkId.mockRejectedValue(new Error('Output failed'))
        await route.refresh()
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }))
    })

    it('opens the device picker synchronously and leaves the preference alone on cancellation', async () => {
        const { route, mediaDevices } = setup()
        const picked = route.select('choose')
        expect(mediaDevices.selectAudioOutput).toHaveBeenCalledOnce()
        await picked
        expect(localStorage.getItem('hapi.readbackOutput')).toBe(speaker.deviceId)
        mediaDevices.selectAudioOutput.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'))
        await route.select('choose')
        expect(localStorage.getItem('hapi.readbackOutput')).toBe(speaker.deviceId)
        await route.select('system')
        expect(localStorage.getItem('hapi.readbackOutput')).toBe('system')
    })

    it('continues on browsers without routing or enumeration APIs', async () => {
        vi.stubGlobal('navigator', {})
        const changed = vi.fn()
        const route = new ReadbackOutput({ destination: {} } as AudioContext, changed)
        routes.push(route)
        await route.refresh()
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable', canPick: false }))
    })

    it('keeps background playback independent of device enumeration until the page is visible', async () => {
        const { route, mediaDevices } = setup()
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
        await route.refresh()
        expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled()
        visibility.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        await route.refresh()
        expect(mediaDevices.enumerateDevices).toHaveBeenCalled()
    })

    it('ignores enumeration that finishes after close and removes device listeners', async () => {
        const { route, audio, mediaDevices, changed } = setup()
        let resolve!: (devices: MediaDeviceInfo[]) => void
        mediaDevices.enumerateDevices.mockReturnValue(new Promise(done => { resolve = done }))
        const pending = route.refresh()
        await Promise.resolve()
        route.close()
        resolve([speaker])
        await pending
        mediaDevices.dispatchEvent(new Event('devicechange'))
        expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce()
        expect(audio.setSinkId).not.toHaveBeenCalled()
        expect(changed).not.toHaveBeenCalled()
    })

    it.each([false, true])('uses an HTML audio bridge when only media elements support routing (autoplay denied: %s)', async (denied) => {
        const { mediaDevices } = setup()
        const sink = vi.fn(async () => {})
        vi.stubGlobal('HTMLMediaElement', class { setSinkId = sink })
        Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { value: sink })
        const play = vi.fn(async () => { if (denied) throw new DOMException('Autoplay', 'NotAllowedError') })
        const pause = vi.fn()
        const element = { setSinkId: sink, play, pause, srcObject: null }
        vi.stubGlobal('Audio', class { constructor() { return element } })
        const stop = vi.fn()
        const bridge = { stream: { getTracks: () => [{ stop }] } }
        const audio = { destination: {}, createMediaStreamDestination: vi.fn(() => bridge) }
        const changed = vi.fn()
        const route = new ReadbackOutput(audio as unknown as AudioContext, changed)
        routes.push(route)
        const node = { connect: vi.fn(), disconnect: vi.fn() }
        route.attach(node as unknown as AudioNode)
        await route.refresh()
        expect(play).toHaveBeenCalledOnce()
        expect(node.connect).toHaveBeenLastCalledWith(denied ? audio.destination : bridge)
        expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ status: denied ? 'unavailable' : 'selected' }))
        if (!denied) {
            await route.select('system')
            expect(node.connect).toHaveBeenLastCalledWith(audio.destination)
        }
        route.close()
        expect(element.srcObject).toBeNull()
        expect(stop).toHaveBeenCalledOnce()
        expect(mediaDevices.selectAudioOutput).not.toHaveBeenCalled()
    })
})
