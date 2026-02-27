import type { MiddlewareHandler } from 'hono'
import type { Permission } from '../../store/types'
import type { AuthService } from '../../auth/authService'

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
        const token = tokenFromHeader ?? tokenFromQuery

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
        await next()
        return
    }
}
