// Averages each 1/16000 s window of mic samples into a 16 kHz PCM16 frame, posted every 50 ms.
const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
    constructor() { super(); this.running = true; this.port.onmessage = () => { this.running = false }; this.step = sampleRate / 16000; this.pos = 0; this.sum = 0; this.count = 0; this.out = new Int16Array(800); this.n = 0 }
    process(inputs) {
        if (!this.running) return false;
        for (const sample of inputs[0]?.[0] ?? []) {
            this.sum += sample; this.count++
            if (++this.pos < this.step) continue
            this.pos -= this.step
            this.out[this.n++] = Math.max(-1, Math.min(1, this.sum / this.count)) * 0x7fff
            this.sum = 0; this.count = 0
            if (this.n === this.out.length) { this.port.postMessage(this.out.buffer, [this.out.buffer]); this.out = new Int16Array(800); this.n = 0 }
        }
        return true
    }
}
registerProcessor('pcm16', Pcm16)`

/** Loads the 16 kHz PCM16 worklet into `audio`; the node posts one 50 ms ArrayBuffer frame per message. */
const modules = new WeakMap<AudioContext, Promise<void>>()

export async function addPcm16Worklet(audio: AudioContext): Promise<AudioWorkletNode> {
    let module = modules.get(audio)
    if (!module) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
        module = audio.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
        modules.set(audio, module)
        module.catch(() => modules.delete(audio))
    }
    await module
    return new AudioWorkletNode(audio, 'pcm16')
}

export function stopPcm16Worklet(node: AudioWorkletNode): void {
    node.port.onmessage = null
    node.port.postMessage('stop')
    node.disconnect()
}
