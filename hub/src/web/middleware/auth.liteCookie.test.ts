import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { AuthService } from '../../auth/authService'
import { createAuthMiddleware, type WebAppEnv } from './auth'

/**
 * The lite UI's EventSource cannot send an Authorization header, so `/api/events` has to
 * accept its cookie. That cookie is long-lived and typically holds a raw admin-scoped
 * token, so the exception must stay pinned to that one route.
 */

function makeApp(): Hono<WebAppEnv> {
    const authService = {
        verifyJwt: async (token: string) =>
            token === 'jwt-ok'
                ? { userId: 1, namespace: 'default', permissions: ['admin'], jti: 'j', apiKeyId: 'k', accessTokenId: null }
                : null,
        authenticateCliToken: (token: string) =>
            token === 'lite-ok'
                ? { namespace: 'default', permissions: ['admin'], apiKeyId: 'k', accessTokenId: null }
                : null
    } as unknown as AuthService

    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(authService))
    app.all('/api/*', (c) => c.json({ ok: true }))
    return app
}

describe('hapi_lite cookie scope', () => {
    it('authenticates the SSE endpoint the lite UI depends on', async () => {
        const res = await makeApp().request('/api/events', {
            headers: { cookie: 'hapi_lite=lite-ok' }
        })
        expect(res.status).toBe(200)
    })

    it('is not honoured on other API routes', async () => {
        for (const path of ['/api/sessions', '/api/credentials', '/api/api-keys']) {
            const res = await makeApp().request(path, {
                headers: { cookie: 'hapi_lite=lite-ok' }
            })
            expect(res.status).toBe(401)
        }
    })

    it('leaves the SPA session cookie working everywhere', async () => {
        const res = await makeApp().request('/api/sessions', {
            headers: { cookie: 'hapi_token=jwt-ok' }
        })
        expect(res.status).toBe(200)
    })

    it('still prefers the SPA cookie on the SSE endpoint', async () => {
        const res = await makeApp().request('/api/events', {
            headers: { cookie: 'hapi_token=jwt-ok; hapi_lite=bogus' }
        })
        expect(res.status).toBe(200)
    })
})

describe('explicit credentials', () => {
    it('rejects a bad bearer token instead of falling back to a cookie', async () => {
        // Falling back would run the request with the cookie's permissions under an
        // identity the caller never claimed.
        const res = await makeApp().request('/api/sessions', {
            headers: { authorization: 'Bearer revoked', cookie: 'hapi_token=jwt-ok' }
        })
        expect(res.status).toBe(401)
    })

    it('rejects a bad ?token= the same way', async () => {
        const res = await makeApp().request('/api/sessions?token=revoked', {
            headers: { cookie: 'hapi_token=jwt-ok' }
        })
        expect(res.status).toBe(401)
    })

    it('accepts a good bearer token', async () => {
        const res = await makeApp().request('/api/sessions', {
            headers: { authorization: 'Bearer jwt-ok' }
        })
        expect(res.status).toBe(200)
    })
})
