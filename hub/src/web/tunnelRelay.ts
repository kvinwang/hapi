import type { ServerWebSocket } from 'bun'
import type { TunnelRegistry } from '../socket/tunnelRegistry'

export type TunnelWsData = {
    _tunnel: true
    tunnelId: string
    role: 'connect' | 'runner'
}

type WsPair = {
    connect: ServerWebSocket<TunnelWsData> | null
    runner: ServerWebSocket<TunnelWsData> | null
}

export class TunnelRelay {
    private readonly pairs = new Map<string, WsPair>()
    private readonly tunnelRegistry: TunnelRegistry

    constructor(tunnelRegistry: TunnelRegistry) {
        this.tunnelRegistry = tunnelRegistry
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
            const sent = target.send(data)
            // Backpressure: if send returns 0 (backpressure), we could pause the source
            // For now, Bun handles internal buffering
            if (sent === 0) {
                // TODO: implement explicit backpressure if needed
            }
        }
    }

    onClose(ws: ServerWebSocket<TunnelWsData>): void {
        const { tunnelId, role } = ws.data
        const pair = this.pairs.get(tunnelId)
        if (!pair) return

        const other = role === 'connect' ? pair.runner : pair.connect
        if (other) {
            try { other.close() } catch {}
        }
        this.pairs.delete(tunnelId)
        this.tunnelRegistry.remove(tunnelId)
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
