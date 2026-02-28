import type { ModelMode, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredMachine, StoredSession } from '../../../store'
import type { RpcRegistry } from '../../rpcRegistry'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { TunnelRegistry } from '../../tunnelRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { hasPermission } from '../../../auth/permissions'
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
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
}

export function registerCliHandlers(socket: CliSocketWithData, deps: CliHandlersDeps): void {
    const { io, store, rpcRegistry, terminalRegistry, tunnelRegistry, onSessionAlive, onSessionEnd, onMachineAlive, onWebappEvent } = deps
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

    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
    if (sessionId && canWriteSessions && resolveSessionAccess(sessionId).ok) {
        socket.join(`session:${sessionId}`)
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    if (machineId && canWriteMachines && resolveMachineAccess(machineId).ok) {
        socket.join(`machine:${machineId}`)
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
    // Tunnel handlers require machines:write
    if (canWriteMachines) {
        registerTunnelHandlers(socket, {
            tunnelRegistry,
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
    })
}
