import { expect, it } from 'vitest'
import { createMicrophoneGate } from './microphoneGate'

const frame = (value: number) => new Int16Array(800).fill(value).buffer
const samples = (buffer: ArrayBuffer) => new Int16Array(buffer)

it('sends only silence for distant quiet input at one percent sensitivity', () => {
    const gate = createMicrophoneGate()
    for (let i = 0; i < 100; i++) {
        expect(samples(gate(frame(300), 300 / 32768, 1)).every(value => value === 0)).toBe(true)
    }
})

it('retains the onset and tail, then returns to silence', () => {
    const gate = createMicrophoneGate()
    for (let i = 0; i < 4; i++) gate(frame(100), 0.003, 50)
    expect(samples(gate(frame(2000), 0.06, 50))[0]).toBe(100)
    for (let i = 0; i < 4; i++) gate(frame(100), 0.003, 50)
    expect(samples(gate(frame(100), 0.003, 50))[0]).toBe(100)
    for (let i = 0; i < 20; i++) gate(frame(100), 0.003, 50)
    expect(samples(gate(frame(100), 0.003, 50))[0]).toBe(0)
})

it('applies sensitivity changes to the same capture stream', () => {
    const gate = createMicrophoneGate()
    for (let i = 0; i < 5; i++) gate(frame(300), 0.009, 1)
    expect(samples(gate(frame(300), 0.009, 1))[0]).toBe(0)
    expect(samples(gate(frame(300), 0.009, 100))[0]).toBe(300)
})
