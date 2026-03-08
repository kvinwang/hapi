import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Permission } from '../../store/types'
import type { AuthService } from '../../auth/authService'
import { hasPermission } from '../../auth/permissions'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
        permissions: Permission[]
        jti: string
        apiKeyId: string
        accessTokenId: string | null
    }
}

export function createAuthMiddleware(authService: AuthService): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (path === '/api/auth' || path === '/api/bind' || path.startsWith('/api/qr')) {
            await next()
            return
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        const tokenFromQuery = (path === '/api/events' || path.startsWith('/api/sync/')) ? c.req.query().token : undefined
        const tokenFromCookie = getCookie(c, 'hapi_token')
        const token = tokenFromHeader ?? tokenFromQuery ?? tokenFromCookie

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        const result = await authService.verifyJwt(token)
        if (!result) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('userId', result.userId)
        c.set('namespace', result.namespace)
        c.set('permissions', result.permissions)
        c.set('jti', result.jti)
        c.set('apiKeyId', result.apiKeyId)
        c.set('accessTokenId', result.accessTokenId)

        // Enforce permissions based on route pattern
        const required = getRequiredPermission(c.req.method, path)
        if (required && !hasPermission(result.permissions, required)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        await next()
        return
    }
}

/**
 * Determine the required permission for a web API route.
 * Returns null for routes that only need valid authentication (no specific permission).
 */
function getRequiredPermission(method: string, path: string): Permission | null {
    // Credential routes — sensitive, require admin
    if (path.includes('/credentials')) return 'admin'

    // API key management
    if (path.startsWith('/api/api-keys')) return 'api_keys:manage'

    // Machine management
    if (path.includes('/unbind')) return 'machines:manage'
    if (path.startsWith('/api/machines')) {
        return method === 'GET' ? 'machines:read' : 'machines:write'
    }

    // Everything else (sessions, messages, sync, events, git, push, voice, etc.)
    return method === 'GET' ? 'sessions:read' : 'sessions:write'
}
