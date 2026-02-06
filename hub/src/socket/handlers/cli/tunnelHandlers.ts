import {
    TunnelRequestPayloadSchema,
    TunnelReadyPayloadSchema,
    TunnelDataPayloadSchema,
    TunnelClosePayloadSchema,
    TunnelErrorPayloadSchema
} from '@hapi/protocol'
import type { StoredMachine } from '../../../store'
import type { TunnelRegistry } from '../../tunnelRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type SocketNamespace = ReturnType<SocketServer['of']>

export type TunnelHandlersDeps = {
    tunnelRegistry: TunnelRegistry
    cliNamespace: SocketNamespace
    resolveMachineAccess: (machineId: string) => AccessResult<StoredMachine>
    emitAccessError: (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void
}

export function registerTunnelHandlers(
    socket: CliSocketWithData,
    deps: TunnelHandlersDeps
): void {
    const { tunnelRegistry, cliNamespace, resolveMachineAccess, emitAccessError } = deps

    socket.on('tunnel:request', (data: unknown) => {
        const parsed = TunnelRequestPayloadSchema.safeParse(data)
        if (!parsed.success) return

        const { tunnelId, machineId, port, host } = parsed.data

        const machineAccess = resolveMachineAccess(machineId)
        if (!machineAccess.ok) {
            emitAccessError('machine', machineId, machineAccess.reason)
            socket.emit('tunnel:error', { tunnelId, message: `Machine ${machineAccess.reason}` })
            return
        }

        // Find runner socket via machine room
        const room = cliNamespace.adapter.rooms.get(`machine:${machineId}`)
        if (!room || room.size === 0) {
            socket.emit('tunnel:error', { tunnelId, message: 'Runner not connected' })
            return
        }

        // Pick a runner socket (not ourselves)
        let runnerSocketId: string | null = null
        for (const sid of room) {
            if (sid !== socket.id) {
                runnerSocketId = sid
                break
            }
        }

        if (!runnerSocketId) {
            socket.emit('tunnel:error', { tunnelId, message: 'Runner not connected' })
            return
        }

        const runnerSocket = cliNamespace.sockets.get(runnerSocketId)
        if (!runnerSocket) {
            socket.emit('tunnel:error', { tunnelId, message: 'Runner socket not found' })
            return
        }

        const entry = tunnelRegistry.register(tunnelId, machineId, port, socket.id, runnerSocketId)
        if (!entry) {
            socket.emit('tunnel:error', { tunnelId, message: 'Tunnel ID already in use' })
            return
        }

        runnerSocket.emit('tunnel:open', { tunnelId, port, ...(host ? { host } : {}) })
    })

    socket.on('tunnel:ready', (data: unknown) => {
        const parsed = TunnelReadyPayloadSchema.safeParse(data)
        if (!parsed.success) return

        const entry = tunnelRegistry.get(parsed.data.tunnelId)
        if (!entry || entry.runnerSocketId !== socket.id) return

        const connectSocket = cliNamespace.sockets.get(entry.connectSocketId)
        connectSocket?.emit('tunnel:ready', parsed.data)
        tunnelRegistry.markActivity(parsed.data.tunnelId)
    })

    socket.on('tunnel:data', (data: unknown) => {
        const parsed = TunnelDataPayloadSchema.safeParse(data)
        if (!parsed.success) return

        const entry = tunnelRegistry.get(parsed.data.tunnelId)
        if (!entry) return

        tunnelRegistry.markActivity(parsed.data.tunnelId)

        if (socket.id === entry.connectSocketId) {
            const runnerSocket = cliNamespace.sockets.get(entry.runnerSocketId)
            runnerSocket?.emit('tunnel:data', parsed.data)
        } else if (socket.id === entry.runnerSocketId) {
            const connectSocket = cliNamespace.sockets.get(entry.connectSocketId)
            connectSocket?.emit('tunnel:data', parsed.data)
        }
    })

    socket.on('tunnel:close', (data: unknown) => {
        const parsed = TunnelClosePayloadSchema.safeParse(data)
        if (!parsed.success) return

        const entry = tunnelRegistry.get(parsed.data.tunnelId)
        if (!entry) return

        const targetSocketId = socket.id === entry.connectSocketId
            ? entry.runnerSocketId
            : entry.connectSocketId
        const targetSocket = cliNamespace.sockets.get(targetSocketId)
        targetSocket?.emit('tunnel:close', parsed.data)

        tunnelRegistry.remove(parsed.data.tunnelId)
    })

    socket.on('tunnel:error', (data: unknown) => {
        const parsed = TunnelErrorPayloadSchema.safeParse(data)
        if (!parsed.success) return

        const entry = tunnelRegistry.get(parsed.data.tunnelId)
        if (!entry) return

        if (socket.id === entry.runnerSocketId) {
            const connectSocket = cliNamespace.sockets.get(entry.connectSocketId)
            connectSocket?.emit('tunnel:error', parsed.data)
        }

        tunnelRegistry.remove(parsed.data.tunnelId)
    })
}

export function cleanupTunnelHandlers(
    socket: CliSocketWithData,
    deps: { tunnelRegistry: TunnelRegistry; cliNamespace: SocketNamespace }
): void {
    const connectTunnels = deps.tunnelRegistry.removeByConnectSocket(socket.id)
    for (const entry of connectTunnels) {
        const runnerSocket = deps.cliNamespace.sockets.get(entry.runnerSocketId)
        runnerSocket?.emit('tunnel:close', { tunnelId: entry.tunnelId })
    }

    const runnerTunnels = deps.tunnelRegistry.removeByRunnerSocket(socket.id)
    for (const entry of runnerTunnels) {
        const connectSocket = deps.cliNamespace.sockets.get(entry.connectSocketId)
        connectSocket?.emit('tunnel:error', {
            tunnelId: entry.tunnelId,
            message: 'Runner disconnected'
        })
    }
}
