export class SessionConnections {
    private readonly socketIdBySessionId = new Map<string, string>()

    claim(sessionId: string, socketId: string): void {
        this.socketIdBySessionId.set(sessionId, socketId)
    }

    isCurrent(sessionId: string, socketId: string): boolean {
        return this.socketIdBySessionId.get(sessionId) === socketId
    }

    release(sessionId: string, socketId: string): void {
        if (this.isCurrent(sessionId, socketId)) {
            this.socketIdBySessionId.delete(sessionId)
        }
    }
}
