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

        // Every candidate is tried rather than just the first present one. A browser can
        // hold both cookies at once, and picking one would 401 whenever that particular
        // credential happened to be the expired one — which for the lite UI silently
        // kills live updates while the page itself stays authenticated.
        const candidates = [tokenFromHeader, tokenFromQuery, getCookie(c, 'hapi_token'), liteCookie]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)

        if (candidates.length === 0) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        let authenticated = false
        for (const candidate of candidates) {
            // Try JWT first (webapp sessions)
            const jwtResult = await authService.verifyJwt(candidate)
            if (jwtResult) {
                c.set('userId', jwtResult.userId)
                c.set('namespace', jwtResult.namespace)
                c.set('permissions', jwtResult.permissions)
                c.set('jti', jwtResult.jti)
                c.set('apiKeyId', jwtResult.apiKeyId)
                c.set('accessTokenId', jwtResult.accessTokenId)
                authenticated = true
                break
            }

            // Fall back to CLI token (API key / access token)
            const cliResult = authService.authenticateCliToken(candidate)
            if (cliResult) {
                c.set('userId', 0)
                c.set('namespace', cliResult.namespace)
                c.set('permissions', cliResult.permissions)
                c.set('jti', '')
                c.set('apiKeyId', cliResult.apiKeyId)
                c.set('accessTokenId', cliResult.accessTokenId)
                authenticated = true
                break
            }
        }

        if (!authenticated) {
            return c.json({ error: 'Invalid token' }, 401)
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
