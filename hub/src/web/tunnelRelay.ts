// Tunnel WebSocket relay
//
// Manages two kinds of WebSocket connections for tunnel data transport:
//
// 1. Per-tunnel WS pair: A connect CLI and a runner each open a WS to
//    /tunnel/ws/:tunnelId. The relay forwards binary frames between them.
//    When only one side has a WS, the fallback function bridges to Socket.IO.
//
// 2. Pool WS: Runners pre-establish idle WebSocket connections to /tunnel/pool.
//    When a tunnel is created, the hub assigns an idle pool WS to the tunnel
//    (zero additional handshake latency). The assignment protocol:
//      Hub sends {"assign":"<tunnelId>"} → installs as pair.runner immediately
//      Runner receives, wires WS ↔ TCP, opens a replacement idle WS

import type { ServerWebSocket } from 'bun'
import type { TunnelRegistry } from '../socket/tunnelRegistry'

/** Hub waits this long for an idle pool WS before giving up. */
export const POOL_ACQUIRE_TIMEOUT_MS = 3000

export type TunnelWsData = {
    _tunnel: true
    tunnelId: string
    role: 'connect' | 'runner'
}

export type PoolWsData = {
    _tunnel: true
    _pool: true
    machineId: string
    tunnelId: string | null  // null = idle, set when assigned
}

/** Called when data arrives on WebSocket but the other side has no WebSocket (old client). */
export type TunnelFallbackFn = (tunnelId: string, senderRole: 'connect' | 'runner', data: Buffer | ArrayBuffer | string) => void

type WsPair = {
    connect: ServerWebSocket<TunnelWsData> | null
    runner: ServerWebSocket<TunnelWsData | PoolWsData> | null
}

type PoolWaiter = {
    resolve: (ws: ServerWebSocket<PoolWsData> | null) => void
    timer: ReturnType<typeof setTimeout>
}

export class TunnelRelay {
    private readonly pairs = new Map<string, WsPair>()
    private readonly tunnelRegistry: TunnelRegistry
    private readonly fallback: TunnelFallbackFn | null

    // Pool: per-machineId idle WebSocket connections from runners
    private readonly pool = new Map<string, ServerWebSocket<PoolWsData>[]>()
    private readonly poolWaiters = new Map<string, PoolWaiter[]>()

    constructor(tunnelRegistry: TunnelRegistry, fallback?: TunnelFallbackFn) {
        this.tunnelRegistry = tunnelRegistry
        this.fallback = fallback ?? null
    }

    // --- Per-tunnel WebSocket pair management ---

    onOpen(ws: ServerWebSocket<TunnelWsData>): void {
        const { tunnelId, role } = ws.data
        let pair = this.pairs.get(tunnelId)
        if (!pair) {
            pair = { connect: null, runner: null }
            this.pairs.set(tunnelId, pair)
        }
        pair[role] = ws
    }

    onMessage(ws: ServerWebSocket<TunnelWsData | PoolWsData>, data: Buffer | ArrayBuffer | string): void {
        const wsData = ws.data
        const tunnelId = wsData.tunnelId
        if (!tunnelId) return

        const pair = this.pairs.get(tunnelId)
        if (!pair) return

        this.tunnelRegistry.markActivity(tunnelId)

        const role = '_pool' in wsData ? 'runner' : wsData.role
        const target = role === 'connect' ? pair.runner : pair.connect
        if (target) {
            target.send(data)
        } else if (this.fallback) {
            this.fallback(tunnelId, role, data)
        }
    }

    onClose(ws: ServerWebSocket<TunnelWsData>): void {
        const { tunnelId, role } = ws.data
        const pair = this.pairs.get(tunnelId)
        if (!pair) return

        pair[role] = null

        // If the tunnel is still registered, the Socket.IO side can handle data.
        // Only clean up the WS pair entry when both sides are gone.
        if (this.tunnelRegistry.get(tunnelId)) {
            // Tunnel still alive — let Socket.IO fallback handle data flow.
            // Clean up pair entry only if both WS are gone.
            if (!pair.connect && !pair.runner) {
                this.pairs.delete(tunnelId)
            }
            return
        }

        // Tunnel already removed — cascade close to the other side
        const other = role === 'connect' ? pair.runner : pair.connect
        if (other) {
            try { other.close() } catch {}
        }
        this.pairs.delete(tunnelId)
    }

    onDrain(_ws: ServerWebSocket<TunnelWsData>): void {
        // Informational for now
    }

    hasPair(tunnelId: string): boolean {
        return this.pairs.has(tunnelId)
    }

    hasWebSocket(tunnelId: string, role: 'connect' | 'runner'): boolean {
        const pair = this.pairs.get(tunnelId)
        return pair?.[role] != null
    }

    cleanup(tunnelId: string): void {
        const pair = this.pairs.get(tunnelId)
        if (!pair) return
        try { pair.connect?.close() } catch {}
        try { pair.runner?.close() } catch {}
        this.pairs.delete(tunnelId)
    }

    // --- Pool WebSocket management ---

    addPoolWs(ws: ServerWebSocket<PoolWsData>): void {
        const { machineId } = ws.data
        // Check if there's a waiter for this machine
        const waiters = this.poolWaiters.get(machineId)
        if (waiters && waiters.length > 0) {
            const waiter = waiters.shift()!
            if (waiters.length === 0) this.poolWaiters.delete(machineId)
            clearTimeout(waiter.timer)
            waiter.resolve(ws)
            return
        }
        // No waiter — add to idle pool
        let list = this.pool.get(machineId)
        if (!list) {
            list = []
            this.pool.set(machineId, list)
        }
        list.push(ws)
    }

    /** Acquire an idle pool WS for a machine, or wait up to timeoutMs for one. */
    acquirePoolWs(machineId: string, timeoutMs = POOL_ACQUIRE_TIMEOUT_MS): Promise<ServerWebSocket<PoolWsData> | null> {
        // Try immediate
        const list = this.pool.get(machineId)
        if (list && list.length > 0) {
            const ws = list.shift()!
            if (list.length === 0) this.pool.delete(machineId)
            return Promise.resolve(ws)
        }
        // Wait for a new pool WS to arrive
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                // Timeout — remove waiter
                const waiters = this.poolWaiters.get(machineId)
                if (waiters) {
                    const idx = waiters.findIndex(w => w.resolve === resolve)
                    if (idx >= 0) waiters.splice(idx, 1)
                    if (waiters.length === 0) this.poolWaiters.delete(machineId)
                }
                resolve(null)
            }, timeoutMs)
            let waiters = this.poolWaiters.get(machineId)
            if (!waiters) {
                waiters = []
                this.poolWaiters.set(machineId, waiters)
            }
            waiters.push({ resolve, timer })
        })
    }

    /**
     * Assign a pool WS to a tunnel.
     *
     * pair.runner is installed immediately so the connect WS can forward data
     * without falling through to the Socket.IO fallback. Data sent to the pool
     * WS before the runner processes the assignment will buffer in its stream.
     */
    assignPoolWs(ws: ServerWebSocket<PoolWsData>, tunnelId: string): void {
        ws.data.tunnelId = tunnelId
        let pair = this.pairs.get(tunnelId)
        if (!pair) {
            pair = { connect: null, runner: null }
            this.pairs.set(tunnelId, pair)
        }
        pair.runner = ws as ServerWebSocket<any>
        ws.send(JSON.stringify({ assign: tunnelId }))
    }

    /** Handle messages on assigned pool WS — relay binary data only. */
    onPoolMessage(ws: ServerWebSocket<PoolWsData>, data: Buffer | ArrayBuffer | string): void {
        const { tunnelId } = ws.data
        if (!tunnelId) return // idle WS shouldn't send data
        if (typeof data === 'string') return // text frames are control messages, not tunnel data
        this.onMessage(ws, data)
    }

    /** Remove a pool WS (on close). */
    removePoolWs(ws: ServerWebSocket<PoolWsData>): void {
        const { machineId, tunnelId } = ws.data
        if (tunnelId) {
            // Was assigned to a tunnel — handle like a tunnel close
            const pair = this.pairs.get(tunnelId)
            if (pair) {
                pair.runner = null
                if (pair.connect) {
                    try { pair.connect.close() } catch {}
                    this.pairs.delete(tunnelId)
                    this.tunnelRegistry.remove(tunnelId)
                } else {
                    this.pairs.delete(tunnelId)
                }
            }
        } else {
            // Was idle — remove from pool
            const list = this.pool.get(machineId)
            if (list) {
                const idx = list.indexOf(ws)
                if (idx >= 0) list.splice(idx, 1)
                if (list.length === 0) this.pool.delete(machineId)
            }
        }
    }

    /** Remove all pool connections for a machine (on runner disconnect). */
    removeAllPoolWs(machineId: string): void {
        const list = this.pool.get(machineId)
        if (list) {
            for (const ws of list) {
                try { ws.close() } catch {}
            }
            this.pool.delete(machineId)
        }
        // Cancel any waiters
        const waiters = this.poolWaiters.get(machineId)
        if (waiters) {
            for (const w of waiters) {
                clearTimeout(w.timer)
                w.resolve(null)
            }
            this.poolWaiters.delete(machineId)
        }
    }
}
