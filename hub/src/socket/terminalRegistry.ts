export type TerminalRegistryEntry = {
    terminalId: string
    sessionId: string
    socketId: string | null
    cliSocketId: string
    idleTimer: ReturnType<typeof setTimeout> | null
    outputBuffer: string
}

type TerminalRegistryOptions = {
    idleTimeoutMs: number
    onIdle?: (entry: TerminalRegistryEntry) => void
    outputBufferMaxBytes?: number
}

export class TerminalRegistry {
    private readonly terminals = new Map<string, TerminalRegistryEntry>()
    private readonly terminalsBySocket = new Map<string, Set<string>>()
    private readonly terminalsBySession = new Map<string, Set<string>>()
    private readonly terminalsByCliSocket = new Map<string, Set<string>>()
    private readonly idleTimeoutMs: number
    private readonly onIdle?: (entry: TerminalRegistryEntry) => void
    private readonly outputBufferMaxBytes: number

    constructor(options: TerminalRegistryOptions) {
        this.idleTimeoutMs = options.idleTimeoutMs
        this.onIdle = options.onIdle
        this.outputBufferMaxBytes = options.outputBufferMaxBytes ?? 200_000
    }

    register(terminalId: string, sessionId: string, socketId: string, cliSocketId: string): TerminalRegistryEntry | null {
        if (this.terminals.has(terminalId)) {
            return null
        }

        const entry: TerminalRegistryEntry = {
            terminalId,
            sessionId,
            socketId,
            cliSocketId,
            idleTimer: null,
            outputBuffer: ''
        }

        this.terminals.set(terminalId, entry)
        this.addToIndex(this.terminalsBySocket, socketId, terminalId)
        this.addToIndex(this.terminalsBySession, sessionId, terminalId)
        this.addToIndex(this.terminalsByCliSocket, cliSocketId, terminalId)
        this.scheduleIdle(entry)

        return entry
    }

    attach(terminalId: string, socketId: string, cliSocketId: string): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return null
        }

        if (entry.socketId && entry.socketId !== socketId) {
            this.removeFromIndex(this.terminalsBySocket, entry.socketId, terminalId)
        }
        if (entry.cliSocketId !== cliSocketId) {
            this.removeFromIndex(this.terminalsByCliSocket, entry.cliSocketId, terminalId)
        }
        entry.socketId = socketId
        entry.cliSocketId = cliSocketId
        this.addToIndex(this.terminalsBySocket, socketId, terminalId)
        this.addToIndex(this.terminalsByCliSocket, cliSocketId, terminalId)
        this.scheduleIdle(entry)
        return entry
    }

    appendOutput(terminalId: string, data: string): void {
        const entry = this.terminals.get(terminalId)
        if (!entry || !data) {
            return
        }

        entry.outputBuffer += data
        if (entry.outputBuffer.length > this.outputBufferMaxBytes) {
            entry.outputBuffer = entry.outputBuffer.slice(entry.outputBuffer.length - this.outputBufferMaxBytes)
        }
    }

    getOutputBuffer(terminalId: string): string {
        return this.terminals.get(terminalId)?.outputBuffer ?? ''
    }

    markActivity(terminalId: string): void {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return
        }
        this.scheduleIdle(entry)
    }

    get(terminalId: string): TerminalRegistryEntry | null {
        return this.terminals.get(terminalId) ?? null
    }

    remove(terminalId: string): TerminalRegistryEntry | null {
        const entry = this.terminals.get(terminalId)
        if (!entry) {
            return null
        }

        this.terminals.delete(terminalId)
        if (entry.socketId) {
            this.removeFromIndex(this.terminalsBySocket, entry.socketId, terminalId)
        }
        this.removeFromIndex(this.terminalsBySession, entry.sessionId, terminalId)
        this.removeFromIndex(this.terminalsByCliSocket, entry.cliSocketId, terminalId)
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        return entry
    }

    detachBySocket(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsBySocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        const entries: TerminalRegistryEntry[] = []
        for (const terminalId of ids) {
            const entry = this.terminals.get(terminalId)
            if (!entry) continue
            entry.socketId = null
            this.scheduleIdle(entry)
            entries.push(entry)
        }
        this.terminalsBySocket.delete(socketId)
        return entries
    }

    removeByCliSocket(socketId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsByCliSocket.get(socketId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids).map((terminalId) => this.remove(terminalId)).filter(Boolean) as TerminalRegistryEntry[]
    }

    countForSocket(socketId: string): number {
        return this.terminalsBySocket.get(socketId)?.size ?? 0
    }

    countForSession(sessionId: string): number {
        return this.terminalsBySession.get(sessionId)?.size ?? 0
    }

    getBySession(sessionId: string): TerminalRegistryEntry[] {
        const ids = this.terminalsBySession.get(sessionId)
        if (!ids || ids.size === 0) {
            return []
        }
        return Array.from(ids)
            .map((terminalId) => this.terminals.get(terminalId))
            .filter(Boolean) as TerminalRegistryEntry[]
    }

    private scheduleIdle(entry: TerminalRegistryEntry): void {
        if (this.idleTimeoutMs <= 0) {
            return
        }

        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer)
        }

        entry.idleTimer = setTimeout(() => {
            const current = this.terminals.get(entry.terminalId)
            if (!current) {
                return
            }
            this.onIdle?.(current)
            this.remove(entry.terminalId)
        }, this.idleTimeoutMs)
    }

    private addToIndex(index: Map<string, Set<string>>, key: string, terminalId: string): void {
        const set = index.get(key)
        if (set) {
            set.add(terminalId)
        } else {
            index.set(key, new Set([terminalId]))
        }
    }

    private removeFromIndex(index: Map<string, Set<string>>, key: string, terminalId: string): void {
        const set = index.get(key)
        if (!set) {
            return
        }
        set.delete(terminalId)
        if (set.size === 0) {
            index.delete(key)
        }
    }
}
