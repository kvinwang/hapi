export type TunnelRegistryEntry = {
    tunnelId: string
    machineId: string
    port: number
    connectSocketId: string
    runnerSocketId: string
    idleTimer: ReturnType<typeof setTimeout> | null
}

type TunnelRegistryOptions = {
    idleTimeoutMs: number
    onIdle?: (entry: TunnelRegistryEntry) => void
}

export class TunnelRegistry {
    private readonly tunnels = new Map<string, TunnelRegistryEntry>()
    private readonly tunnelsByConnectSocket = new Map<string, Set<string>>()
    private readonly tunnelsByRunnerSocket = new Map<string, Set<string>>()
    private readonly idleTimeoutMs: number
    private readonly onIdle?: (entry: TunnelRegistryEntry) => void

    constructor(options: TunnelRegistryOptions) {
        this.idleTimeoutMs = options.idleTimeoutMs
        this.onIdle = options.onIdle
    }

    register(
        tunnelId: string,
        machineId: string,
        port: number,
        connectSocketId: string,
        runnerSocketId: string
    ): TunnelRegistryEntry | null {
        if (this.tunnels.has(tunnelId)) {
            return null
        }

        const entry: TunnelRegistryEntry = {
            tunnelId,
            machineId,
            port,
            connectSocketId,
            runnerSocketId,
            idleTimer: null
        }

        this.tunnels.set(tunnelId, entry)
        this.addToIndex(this.tunnelsByConnectSocket, connectSocketId, tunnelId)
        this.addToIndex(this.tunnelsByRunnerSocket, runnerSocketId, tunnelId)
        this.scheduleIdle(entry)

        return entry
    }

    get(tunnelId: string): TunnelRegistryEntry | null {
        return this.tunnels.get(tunnelId) ?? null
    }

    markActivity(tunnelId: string): void {
        const entry = this.tunnels.get(tunnelId)
        if (!entry) {
            return
        }
        this.scheduleIdle(entry)
    }

    remove(tunnelId: string): TunnelRegistryEntry | null {
        const entry = this.tunnels.get(tunnelId)
        if (!entry) {
            return null
        }

        this.tunnels.delete(tunnelId)
        this.removeFromIndex(this.tunnelsByConnectSocket, entry.connectSocketId, tunnelId)
        this.removeFromIndex(this.tunnelsByRunnerSocket, entry.runnerSocketId, tunnelId)
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        return entry
    }

    removeByConnectSocket(socketId: string): TunnelRegistryEntry[] {
        const ids = this.tunnelsByConnectSocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids)
            .map((tunnelId) => this.remove(tunnelId))
            .filter(Boolean) as TunnelRegistryEntry[]
    }

    removeByRunnerSocket(socketId: string): TunnelRegistryEntry[] {
        const ids = this.tunnelsByRunnerSocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids)
            .map((tunnelId) => this.remove(tunnelId))
            .filter(Boolean) as TunnelRegistryEntry[]
    }

    private scheduleIdle(entry: TunnelRegistryEntry): void {
        if (this.idleTimeoutMs <= 0) {
            return
        }

        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        entry.idleTimer = setTimeout(() => {
            const current = this.tunnels.get(entry.tunnelId)
            if (!current) {
                return
            }
            this.onIdle?.(current)
            this.remove(entry.tunnelId)
        }, this.idleTimeoutMs)
    }

    private addToIndex(index: Map<string, Set<string>>, key: string, tunnelId: string): void {
        const set = index.get(key)
        if (set) {
            set.add(tunnelId)
        } else {
            index.set(key, new Set([tunnelId]))
        }
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string, tunnelId: string): void {
        const set = index.get(key)
        if (!set) {
            return
        }
        set.delete(tunnelId)
        if (set.size === 0) {
            index.delete(key)
        }
    }
}
