/**
 * Uplink server (hub side): SSE downstream + HTTP POST upstream.
 *
 * Adapted from lobstear-relay/src/uplink-server.ts for Hono streamSSE.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { UplinkUp, UplinkDown, UplinkToolCall } from './uplinkProtocol'

interface PendingToolCall {
    resolve: (result: { result: unknown; error?: string }) => void
    timer: ReturnType<typeof setTimeout>
}

export interface UplinkServerEvents {
    connected: []
    disconnected: []
    inbound: [text: string, senderId: string]
    interrupt: []
    speakerStatus: [connected: boolean]
}

export class UplinkServer extends EventEmitter<UplinkServerEvents> {
    private sendFn: ((msg: UplinkDown) => void) | null = null
    private pending = new Map<string, PendingToolCall>()
    private _speakerConnected = false

    get relayConnected(): boolean {
        return this.sendFn !== null
    }

    get speakerConnected(): boolean {
        return this._speakerConnected
    }

    /** Called when SSE stream connects — provides the send function */
    attachStream(send: (msg: UplinkDown) => void): void {
        if (this.sendFn) {
            console.log('[Lobstear] Replacing existing relay SSE connection')
        }
        this.sendFn = send
        console.log('[Lobstear] Relay SSE connected')
        this.emit('connected')
    }

    /** Called when SSE stream disconnects */
    detachStream(): void {
        this.sendFn = null
        this._speakerConnected = false
        console.log('[Lobstear] Relay SSE disconnected')
        this.emit('disconnected')
    }

    /** Process an upstream message from relay */
    processUp(msg: UplinkUp): void {
        switch (msg.type) {
            case 'hello':
                console.log(`[Lobstear] Relay hello: v${msg.version}, speaker=${msg.speakerConnected}`)
                this._speakerConnected = msg.speakerConnected
                this.sendSSE({ type: 'ack' })
                break

            case 'status':
                this._speakerConnected = msg.speakerConnected
                console.log(`[Lobstear] Speaker ${msg.speakerConnected ? 'connected' : 'disconnected'}`)
                this.emit('speakerStatus', msg.speakerConnected)
                break

            case 'inbound':
                console.log(`[Lobstear] Inbound: "${msg.text}" from ${msg.senderId}`)
                this.emit('inbound', msg.text, msg.senderId)
                break

            case 'interrupt':
                console.log('[Lobstear] Interrupt from relay')
                this.emit('interrupt')
                break

            case 'tool_result': {
                const pending = this.pending.get(msg.id)
                if (pending) {
                    clearTimeout(pending.timer)
                    this.pending.delete(msg.id)
                    console.log(`[Lobstear] Tool result: id=${msg.id.slice(0, 8)}, error=${msg.error ?? 'none'}`)
                    pending.resolve({ result: msg.result, error: msg.error })
                } else {
                    console.warn(`[Lobstear] Tool result for unknown id=${msg.id.slice(0, 8)}`)
                }
                break
            }
        }
    }

    /** Send agent response text to relay for TTS playback */
    sendOutbound(text: string): void {
        console.log(`[Lobstear] Outbound: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`)
        this.sendSSE({ type: 'outbound', text })
    }

    /** Execute a tool on relay and wait for result */
    async callTool(
        name: string,
        params: Record<string, unknown>,
        timeoutMs = 30000
    ): Promise<{ result: unknown; error?: string }> {
        if (!this.relayConnected) {
            console.warn(`[Lobstear] callTool(${name}) failed: relay not connected`)
            return { result: null, error: 'relay not connected' }
        }

        const id = randomUUID()
        const call: UplinkToolCall = { type: 'tool_call', id, name, params }
        console.log(`[Lobstear] callTool(${name}) id=${id.slice(0, 8)}`)

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                console.warn(`[Lobstear] callTool(${name}) timeout ${timeoutMs}ms, id=${id.slice(0, 8)}`)
                resolve({ result: null, error: 'tool call timeout' })
            }, timeoutMs)

            this.pending.set(id, { resolve, timer })
            this.sendSSE(call)
        })
    }

    stop(): void {
        this.sendFn = null
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.resolve({ result: null, error: 'server stopped' })
        }
        this.pending.clear()
    }

    private sendSSE(msg: UplinkDown): void {
        this.sendFn?.(msg)
    }
}
