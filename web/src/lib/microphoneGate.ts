/** Gate 50 ms capture frames, retaining 200 ms of onset and 600 ms of speech tail. */
export function createMicrophoneGate() {
    const pending: ArrayBuffer[] = []
    let remaining = 0
    return (frame: ArrayBuffer, rms: number, sensitivity: number): ArrayBuffer => {
        const threshold = 10 ** ((-18 - sensitivity * 0.42) / 20)
        if (rms >= threshold) remaining = 16
        const open = remaining > 0
        remaining = Math.max(0, remaining - 1)
        pending.push(frame)
        const delayed = pending.length > 4 ? pending.shift()! : undefined
        return open && delayed ? delayed : new ArrayBuffer(frame.byteLength)
    }
}
