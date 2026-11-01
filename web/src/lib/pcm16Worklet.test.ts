import { afterEach, describe, expect, it, vi } from 'vitest'
import { addPcm16Worklet, stopPcm16Worklet } from './pcm16Worklet'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('PCM worklet lifecycle', () => {
    it('registers once per audio context across microphone toggles', async () => {
        const addModule = vi.fn(async () => {})
        const audio = { audioWorklet: { addModule } } as unknown as AudioContext
        vi.stubGlobal('AudioWorkletNode', class { constructor(public context: AudioContext, public name: string) {} })
        vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:pcm'), revokeObjectURL: vi.fn() })
        const nodes = await Promise.all([addPcm16Worklet(audio), addPcm16Worklet(audio)])
        expect(addModule).toHaveBeenCalledOnce()
        expect(nodes[0]).not.toBe(nodes[1])
        await addPcm16Worklet(audio)
        expect(addModule).toHaveBeenCalledOnce()
    })

    it('explicitly stops processing before disconnecting capture', () => {
        const events: string[] = []
        const node = { port: { onmessage: vi.fn(), postMessage: (message: string) => events.push(message) }, disconnect: () => events.push('disconnect') } as unknown as AudioWorkletNode
        stopPcm16Worklet(node)
        expect(events).toEqual(['stop', 'disconnect'])
        expect(node.port.onmessage).toBeNull()
    })
})
