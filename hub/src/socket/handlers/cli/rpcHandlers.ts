import { z } from 'zod'
import type { Permission } from '../../../store/types'
import { hasPermission } from '../../../auth/permissions'
import type { RpcRegistry } from '../../rpcRegistry'
import type { CliSocketWithData } from '../../socketTypes'

const rpcRegisterSchema = z.object({
    method: z.string().min(1)
})

const rpcUnregisterSchema = z.object({
    method: z.string().min(1)
})

/**
 * Validate that the socket has permission to register a given RPC method.
 * Methods are formatted as `{scopeId}:{methodName}`.
 * The scopeId is either a machineId or sessionId.
 * We check by seeing which rooms the socket has joined:
 * - If socket is in `machine:{scopeId}` room → needs machines:write
 * - If socket is in `session:{scopeId}` room → needs sessions:write
 * - Otherwise reject (unknown scope)
 */
function canRegisterMethod(socket: CliSocketWithData, method: string): boolean {
    const permissions = socket.data.permissions ?? [] as Permission[]
    if (hasPermission(permissions, 'admin')) return true

    const colonIdx = method.indexOf(':')
    if (colonIdx < 0) return false

    const scopeId = method.slice(0, colonIdx)

    // Check if this socket owns the scope via room membership
    if (socket.rooms.has(`machine:${scopeId}`)) {
        return hasPermission(permissions, 'machines:write')
    }
    if (socket.rooms.has(`session:${scopeId}`)) {
        return hasPermission(permissions, 'sessions:write')
    }

    return false
}

export function registerRpcHandlers(socket: CliSocketWithData, rpcRegistry: RpcRegistry): void {
    socket.on('rpc-register', (data: unknown) => {
        const parsed = rpcRegisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        if (!canRegisterMethod(socket, parsed.data.method)) {
            return
        }
        rpcRegistry.register(socket, parsed.data.method)
    })

    socket.on('rpc-unregister', (data: unknown) => {
        const parsed = rpcUnregisterSchema.safeParse(data)
        if (!parsed.success) {
            return
        }
        rpcRegistry.unregister(socket, parsed.data.method)
    })
}
