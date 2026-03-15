import type { ModelMode, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredMachine, StoredSession } from '../../../store'
import type { RpcRegistry } from '../../rpcRegistry'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { TunnelRegistry } from '../../tunnelRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { hasPermission } from '../../../auth/permissions'
import type { TunnelRelay } from '../../../web/tunnelRelay'
import { registerMachineHandlers } from './machineHandlers'
import { registerRpcHandlers } from './rpcHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'
import { cleanupTunnelHandlers, registerTunnelHandlers } from './tunnelHandlers'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    modelMode?: ModelMode
}

type SessionEndPayload = {
    sid: string
    time: number
}

type MachineAlivePayload = {
    machineId: string
    time: number
}

export type CliHandlersDeps = {
    io: SocketServer
    store: Store
    rpcRegistry: RpcRegistry
    terminalRegistry: TerminalRegistry
    tunnelRegistry: TunnelRegistry
    tunnelRelay: TunnelRelay
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
}

export function registerCliHandlers(socket: CliSocketWithData, deps: CliHandlersDeps): void {
    const { io, store, rpcRegistry, terminalRegistry, tunnelRegistry, tunnelRelay, onSessionAlive, onSessionEnd, onMachineAlive, onWebappEvent } = deps
    const terminalNamespace = io.of('/terminal')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    const resolveSessionAccess = (sessionId: string): AccessResult<StoredSession> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const session = store.sessions.getSessionByNamespace(sessionId, namespace)
        if (session) {
            return { ok: true, value: session }
        }
        if (store.sessions.getSession(sessionId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const resolveMachineAccess = (machineId: string): AccessResult<StoredMachine> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const machine = store.machines.getMachineByNamespace(machineId, namespace)
        if (machine) {
            return { ok: true, value: machine }
        }
        if (store.machines.getMachine(machineId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const permissions = socket.data.permissions ?? []
    const canWriteSessions = hasPermission(permissions, 'sessions:write')
    const canWriteMachines = hasPermission(permissions, 'machines:write')
    const canConnect = hasPermission(permissions, 'machines:connect')

    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
    if (sessionId && canWriteSessions && resolveSessionAccess(sessionId).ok) {
        socket.join(`session:${sessionId}`)
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    const clientType = typeof auth?.clientType === 'string' ? auth.clientType : null
    // Only runners (machine-scoped) join the machine room — tunnel clients must not,
    // otherwise tunnel:open may be emitted to the wrong socket.
    if (machineId && canWriteMachines && clientType !== 'tunnel' && resolveMachineAccess(machineId).ok) {
        // Kick any existing runner for this machine to prevent routing ambiguity
        const cliNs = io.of('/cli')
        const room = cliNs.adapter.rooms.get(`machine:${machineId}`)
        if (room) {
            for (const existingSid of room) {
                if (existingSid !== socket.id) {
                    const existingSocket = cliNs.sockets.get(existingSid)
                    if (existingSocket) {
                        existingSocket.emit('replaced', { reason: 'Another runner connected for this machine' })
                        existingSocket.disconnect(true)
                    }
                }
            }
        }
        socket.join(`machine:${machineId}`)
        // Declare hub capabilities so runner can start pool WS connections
        socket.emit('hub:capabilities', { wsPool: true })
    }

    const emitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => {
        const message = reason === 'access-denied'
            ? `${scope} access denied`
            : reason === 'not-found'
                ? `${scope} not found`
                : 'Namespace missing'
        socket.emit('error', { message, code: reason, scope, id })
    }

    // RPC handlers are unconditional — RPC is a generic transport used by
    // sessions (spawn-happy-session), machines (import-ssh-key), etc.
    registerRpcHandlers(socket, rpcRegistry)

    // Session-related handlers require sessions:write
    if (canWriteSessions) {
        registerSessionHandlers(socket, {
            store,
            resolveSessionAccess,
            emitAccessError,
            onSessionAlive,
            onSessionEnd,
            onWebappEvent
        })
        registerTerminalHandlers(socket, {
            terminalRegistry,
            terminalNamespace,
            resolveSessionAccess,
            emitAccessError
        })
    }

    // Machine-related handlers require machines:write
    if (canWriteMachines) {
        registerMachineHandlers(socket, {
            store,
            resolveMachineAccess,
            emitAccessError,
            onMachineAlive,
            onWebappEvent
        })
    }

    const cliNamespace = io.of('/cli')
    // Tunnel handlers: machines:write for runners, machines:connect for initiating connections
    if (canWriteMachines || canConnect) {
        registerTunnelHandlers(socket, {
            tunnelRegistry,
            tunnelRelay,
            cliNamespace,
            resolveMachineAccess,
            emitAccessError
        })
    }

    socket.on('ping', (callback: () => void) => {
        callback()
    })

    socket.on('disconnect', () => {
        rpcRegistry.unregisterAll(socket)
        cleanupTerminalHandlers(socket, { terminalRegistry, terminalNamespace })
        cleanupTunnelHandlers(socket, { tunnelRegistry, cliNamespace })
        if (machineId && canWriteMachines) {
            tunnelRelay.removeAllPoolWs(machineId)
        }
    })
}
