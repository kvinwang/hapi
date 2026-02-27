import type { Context } from 'hono'
import type { Permission } from '../store/types'
import type { WebAppEnv } from '../web/middleware/auth'

export function hasPermission(permissions: Permission[], required: Permission): boolean {
    if (permissions.includes('admin')) return true
    return permissions.includes(required)
}

/**
 * Check permission in a Hono route handler.
 * Returns a 403 Response if denied, or null if allowed.
 */
export function requirePermission(c: Context<WebAppEnv>, permission: Permission): Response | null {
    const permissions = c.get('permissions') ?? []
    if (hasPermission(permissions, permission)) return null
    return c.json({ error: 'Insufficient permissions' }, 403) as unknown as Response
}
