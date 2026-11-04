type RoutableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type OutputDevices = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> }
export type ReadbackOutputState = {
    preference: string
    label: string | null
    status: 'system' | 'selected' | 'unavailable' | 'failed'
    devices: Array<{ deviceId: string; label: string }>
    canPick: boolean
}

const KEY = 'hapi.readbackOutput'
const isSpeaker = (device: MediaDeviceInfo) => !['default', 'communications', ''].includes(device.deviceId)
    && /speaker|扬声器|喇叭|内置输出|built.in output|internal output/i.test(device.label)
    && !/headphone|headset|earpiece|耳机|听筒/i.test(device.label)

function preference(): string {
    try { return localStorage.getItem(KEY) || 'speaker' } catch { return 'speaker' }
}

/** Select an exposed output without interrupting capture or changing the page's audio category. */
export class ReadbackOutput {
    private readonly devices = navigator.mediaDevices as OutputDevices | undefined
    private state: ReadbackOutputState = { preference: preference(), label: null, status: 'system', devices: [], canPick: false }
    private node?: AudioNode
    private element?: HTMLAudioElement
    private bridge?: MediaStreamAudioDestinationNode
    private destination: AudioNode
    private sinkId: string | undefined
    private closed = false
    private pending: Promise<void> = Promise.resolve()

    constructor(private readonly audio: RoutableContext, private readonly onChange?: (state: ReadbackOutputState) => void) {
        this.destination = audio.destination
        this.state.canPick = this.supported && typeof this.devices?.selectAudioOutput === 'function'
        this.devices?.addEventListener?.('devicechange', this.refresh)
        document.addEventListener('visibilitychange', this.refresh)
    }

    private get supported() {
        return typeof this.audio.setSinkId === 'function' || typeof HTMLMediaElement.prototype.setSinkId === 'function'
    }

    attach(node: AudioNode): void {
        this.node = node
        node.connect(this.destination)
    }

    refresh = (): Promise<void> => {
        this.pending = this.pending.then(() => this.apply()).catch(() => {})
        return this.pending
    }

    async select(value: string): Promise<void> {
        if (this.closed) return
        if (value === 'choose') {
            try {
                const selected = await this.devices?.selectAudioOutput?.()
                if (!selected || this.closed) return
                value = selected.deviceId
            } catch { return }
        }
        this.state = { ...this.state, preference: value }
        try { localStorage.setItem(KEY, value) } catch {}
        await this.refresh()
    }

    private publish(status: ReadbackOutputState['status'], label: string | null = null): void {
        if (this.closed) return
        this.state = { ...this.state, status, label }
        this.onChange?.(this.state)
    }

    private async apply(): Promise<void> {
        if (this.closed || document.visibilityState === 'hidden') return
        let outputs: MediaDeviceInfo[] = []
        try { outputs = (await this.devices?.enumerateDevices() ?? []).filter(device => device.kind === 'audiooutput') } catch {}
        if (this.closed) return
        this.state = { ...this.state, devices: outputs.filter(device => device.label && device.deviceId && !['default', 'communications'].includes(device.deviceId)).map(({ deviceId, label }) => ({ deviceId, label })) }
        const wanted = this.state.preference
        const selected = wanted === 'speaker'
            ? outputs.find(device => isSpeaker(device) && /built.in|internal|内置/i.test(device.label)) ?? outputs.find(isSpeaker)
            : outputs.find(device => device.deviceId === wanted)
        if (!this.supported) { this.publish(wanted === 'system' ? 'system' : 'unavailable'); return }
        try {
            await this.route(selected?.deviceId ?? '')
            this.publish(selected ? 'selected' : wanted === 'system' ? 'system' : 'unavailable', selected?.label ?? null)
        } catch {
            try {
                await this.route('')
                this.publish('unavailable')
            } catch { this.publish('failed') }
        }
    }

    private async route(id: string): Promise<void> {
        if (this.closed || this.sinkId === id) return
        if (this.audio.setSinkId) {
            await this.audio.setSinkId(id)
            this.sinkId = id
            return
        }
        if (!id) {
            this.connect(this.audio.destination)
            this.element?.pause()
            this.sinkId = id
            return
        }
        this.element ??= new Audio()
        this.bridge ??= this.audio.createMediaStreamDestination()
        this.element.srcObject = this.bridge.stream
        await this.element.setSinkId(id)
        if (this.closed) return
        await this.element.play()
        if (this.closed) { this.element.pause(); return }
        this.connect(this.bridge)
        this.sinkId = id
    }

    private connect(destination: AudioNode): void {
        if (this.closed || this.destination === destination) return
        this.node?.disconnect(this.destination)
        this.destination = destination
        this.node?.connect(destination)
    }

    close(): void {
        this.closed = true
        this.devices?.removeEventListener?.('devicechange', this.refresh)
        document.removeEventListener('visibilitychange', this.refresh)
        this.element?.pause()
        if (this.element) this.element.srcObject = null
        this.bridge?.stream.getTracks().forEach(track => track.stop())
        this.node = undefined
    }
}
