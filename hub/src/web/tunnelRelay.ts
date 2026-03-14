import type { ServerWebSocket } from 'bun'
import type { TunnelRegistry } from '../socket/tunnelRegistry'

export type TunnelWsData = {
    _tunnel: true
    tunnelId: string
    role: 'connect' | 'runner'
}

/** Called when data arrives on WebSocket but the other side has no WebSocket (old client). */
export type TunnelFallbackFn = (tunnelId: string, senderRole: 'connect' | 'runner', data: Buffer | ArrayBuffer | string) => void

type WsPair = {
    connect: ServerWebSocket<TunnelWsData> | null
    runner: ServerWebSocket<TunnelWsData> | null
}

export class TunnelRelay {
    private readonly pairs = new Map<string, WsPair>()
    private readonly tunnelRegistry: TunnelRegistry
    private readonly fallback: TunnelFallbackFn | null

    constructor(tunnelRegistry: TunnelRegistry, fallback?: TunnelFallbackFn) {
        this.tunnelRegistry = tunnelRegistry
        this.fallback = fallback ?? null
    }

    onOpen(ws: ServerWebSocket<TunnelWsData>): void {
        const { tunnelId, role } = ws.data
        let pair = this.pairs.get(tunnelId)
        if (!pair) {
            pair = { connect: null, runner: null }
            this.pairs.set(tunnelId, pair)
        }
        pair[role] = ws
    }

    onMessage(ws: ServerWebSocket<TunnelWsData>, data: Buffer | ArrayBuffer | string): void {
        const { tunnelId, role } = ws.data
        const pair = this.pairs.get(tunnelId)
        if (!pair) return

        this.tunnelRegistry.markActivity(tunnelId)

        const target = role === 'connect' ? pair.runner : pair.connect
        if (target) {
            target.send(data)
        } else if (this.fallback) {
            // Other side hasn't upgraded to WebSocket — bridge via Socket.IO
            this.fallback(tunnelId, role, data)
        }
    }

    onClose(ws: ServerWebSocket<TunnelWsData>): void {
        const { tunnelId, role } = ws.data
        const pair = this.pairs.get(tunnelId)
        if (!pair) return

        pair[role] = null
        const other = role === 'connect' ? pair.runner : pair.connect
        if (other) {
            // Both sides had WebSocket — close the other and clean up fully
            try { other.close() } catch {}
            this.pairs.delete(tunnelId)
            this.tunnelRegistry.remove(tunnelId)
        } else {
            // Only one side had WebSocket — remove pair but let Socket.IO handle tunnel lifecycle
            this.pairs.delete(tunnelId)
        }
    }

    onDrain(ws: ServerWebSocket<TunnelWsData>): void {
        // Called when a previously-backpressured WebSocket is ready for more data.
        // With Bun's internal buffering this is mostly informational for now.
    }

    hasPair(tunnelId: string): boolean {
        return this.pairs.has(tunnelId)
    }

    cleanup(tunnelId: string): void {
        const pair = this.pairs.get(tunnelId)
        if (!pair) return
        try { pair.connect?.close() } catch {}
        try { pair.runner?.close() } catch {}
        this.pairs.delete(tunnelId)
    }
}
