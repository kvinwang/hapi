import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type DefaultEventsMap } from 'socket.io'
import type { Store } from '../store'
import { configuration } from '../configuration'
import type { AuthService } from '../auth/authService'
import { hasPermission } from '../auth/permissions'
import { registerCliHandlers } from './handlers/cli'
import { registerTerminalHandlers } from './handlers/terminal'
import { RpcRegistry } from './rpcRegistry'
import type { SyncEvent } from '../sync/syncEngine'
import { TerminalRegistry } from './terminalRegistry'
import { TunnelRegistry } from './tunnelRegistry'
import type { CliSocketWithData, SocketData, SocketServer } from './socketTypes'

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type SocketServerDeps = {
    store: Store
    authService: AuthService
    corsOrigins?: string[]
    getSession?: (sessionId: string) => { active: boolean; namespace: string } | null
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number }) => void
}

export function createSocketServer(deps: SocketServerDeps): {
    io: SocketServer
    engine: Engine
    rpcRegistry: RpcRegistry
} {
    const corsOrigins = (deps.corsOrigins ?? configuration.corsOrigins)
        .filter(o => o !== '*')
    const hasCors = corsOrigins.length > 0
    const corsOptions = hasCors
        ? { origin: corsOrigins, methods: ['GET', 'POST'], credentials: true }
        : undefined

    const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>({
        cors: corsOptions
    })

    const engine = new Engine({
        path: '/socket.io/',
        cors: corsOptions,
        allowRequest: async (req) => {
            if (!hasCors) return
            const origin = req.headers.get('origin')
            if (!origin || corsOrigins.includes(origin)) {
                return
            }
            throw 'Origin not allowed'
        }
    })
    io.bind(engine)

    const rpcRegistry = new RpcRegistry()
    const idleTimeoutMs = resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
    const maxTerminals = resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
    const maxTerminalsPerSocket = maxTerminals
    const maxTerminalsPerSession = maxTerminals
    const cliNs = io.of('/cli')
    const terminalNs = io.of('/terminal')
    const terminalRegistry = new TerminalRegistry({
        idleTimeoutMs,
        onIdle: (entry) => {
            for (const socketId of entry.socketIds) {
                const terminalSocket = terminalNs.sockets.get(socketId)
                terminalSocket?.emit('terminal:error', {
                    terminalId: entry.terminalId,
                    message: 'Terminal closed due to inactivity.'
                })
            }
            const cliSocket = cliNs.sockets.get(entry.cliSocketId)
            cliSocket?.emit('terminal:close', {
                sessionId: entry.sessionId,
                terminalId: entry.terminalId
            })
        }
    })

    const tunnelIdleTimeoutMs = resolveEnvNumber('HAPI_TUNNEL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
    const tunnelRegistry = new TunnelRegistry({
        idleTimeoutMs: tunnelIdleTimeoutMs,
        onIdle: (entry) => {
            const connectSocket = cliNs.sockets.get(entry.connectSocketId)
            connectSocket?.emit('tunnel:close', { tunnelId: entry.tunnelId })
            const runnerSocket = cliNs.sockets.get(entry.runnerSocketId)
            runnerSocket?.emit('tunnel:close', { tunnelId: entry.tunnelId })
        }
    })

    cliNs.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Invalid token'))
        }
        const result = deps.authService.authenticateCliToken(token)
        if (!result) {
            return next(new Error('Invalid token'))
        }
        socket.data.namespace = result.namespace
        socket.data.permissions = result.permissions
        socket.data.apiKeyId = result.apiKeyId
        next()
    })
    cliNs.on('connection', (socket) => registerCliHandlers(socket as CliSocketWithData, {
        io,
        store: deps.store,
        rpcRegistry,
        terminalRegistry,
        tunnelRegistry,
        onSessionAlive: deps.onSessionAlive,
        onSessionEnd: deps.onSessionEnd,
        onMachineAlive: deps.onMachineAlive,
        onWebappEvent: deps.onWebappEvent
    }))

    terminalNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Missing token'))
        }

        const result = await deps.authService.verifyJwt(token)
        if (!result) {
            return next(new Error('Invalid token'))
        }
        socket.data.userId = result.userId
        socket.data.namespace = result.namespace
        socket.data.permissions = result.permissions
        socket.data.apiKeyId = result.apiKeyId
        // Terminal operations require sessions:write
        if (!hasPermission(result.permissions, 'sessions:write')) {
            return next(new Error('Insufficient permissions'))
        }
        next()
    })
    terminalNs.on('connection', (socket) => registerTerminalHandlers(socket, {
        io,
        getSession: (sessionId) => {
            return deps.getSession?.(sessionId) ?? deps.store.sessions.getSession(sessionId)
        },
        terminalRegistry,
        maxTerminalsPerSocket,
        maxTerminalsPerSession
    }))

    return { io, engine, rpcRegistry }
}
