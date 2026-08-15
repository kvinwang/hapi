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
        const tokenFromQuery = c.req.query('token') ?? undefined
        // `hapi_lite` is the low-power UI's cookie, and unlike the 4h `hapi_token` JWT it
        // is long-lived and usually holds a raw admin-scoped token. It is therefore
        // accepted only on the single endpoint that UI needs from `/api` — its
        // EventSource, which cannot send headers and so has no alternative. Honouring it
        // everywhere would put a 30-day ambient credential on `/api/credentials`.
        const liteCookie = path === '/api/events' ? getCookie(c, 'hapi_lite') : undefined
        const tokenFromCookie = getCookie(c, 'hapi_token') ?? liteCookie
        const token = tokenFromHeader ?? tokenFromQuery ?? tokenFromCookie

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        // Try JWT first (webapp sessions)
        const jwtResult = await authService.verifyJwt(token)
        if (jwtResult) {
            c.set('userId', jwtResult.userId)
            c.set('namespace', jwtResult.namespace)
            c.set('permissions', jwtResult.permissions)
            c.set('jti', jwtResult.jti)
            c.set('apiKeyId', jwtResult.apiKeyId)
            c.set('accessTokenId', jwtResult.accessTokenId)
        } else {
            // Fall back to CLI token (API key / access token)
            const cliResult = authService.authenticateCliToken(token)
            if (!cliResult) {
                return c.json({ error: 'Invalid token' }, 401)
            }

            c.set('userId', 0)
            c.set('namespace', cliResult.namespace)
            c.set('permissions', cliResult.permissions)
            c.set('jti', '')
            c.set('apiKeyId', cliResult.apiKeyId)
            c.set('accessTokenId', cliResult.accessTokenId)
        }

        // Enforce permissions based on route pattern
        const required = getRequiredPermission(c.req.method, path)
        if (required && !hasPermission(c.get('permissions'), required)) {
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
        if (method === 'DELETE') return 'machines:manage'
        return method === 'GET' ? 'machines:read' : 'machines:write'
    }

    // Lobstear device routes — all require sessions:write (relay needs write access)
    if (path.startsWith('/api/lobstear')) return 'sessions:write'

    // Everything else (sessions, messages, sync, events, git, push, voice, etc.)
    return method === 'GET' ? 'sessions:read' : 'sessions:write'
}
