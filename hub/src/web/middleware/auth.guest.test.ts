import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'

mock.module('../../configuration', () => ({ configuration: { publicUrl: 'http://localhost' } }))

const { AuthService } = await import('../../auth/authService')
const { RevocationCache } = await import('../../auth/revocationCache')
const { Store } = await import('../../store')
const { hashApiKey } = await import('../../utils/apiKey')
const { createAuthRoutes } = await import('../routes/auth')
const { createAuthMiddleware } = await import('./auth')
import type { WebAppEnv } from './auth'

const CODE = 'ABCD2345'

function setup() {
    const store = new Store(':memory:')
    const authService = new AuthService(
        store,
        new RevocationCache(store.accessTokens, store.apiKeys),
        new TextEncoder().encode('test-secret-test-secret-test-secret'),
        'legacy-token'
    )
    const session = store.sessions.createSession({ tag: 't', namespace: 'default', metadata: { path: '/w' } })
    const grant = store.sessionGrants.create({
        id: 'grant-1',
        sessionId: session.id,
        namespace: 'default',
        codeHash: hashApiKey(CODE),
        description: null,
        allowVoice: false,
        expiresAt: Date.now() + 3600_000
    })

    const app = new Hono<WebAppEnv>()
    app.route('/api', createAuthRoutes(store, authService))
    app.use('/api/*', createAuthMiddleware(authService))
    app.all('/api/*', (c) => c.json({ ok: true }))

    const login = (code: string) => app.request('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guestGrantId: grant.id, code })
    })
    const call = (token: string, method: string, path: string) =>
        app.request(path, { method, headers: { authorization: `Bearer ${token}` } })

    return { store, authService, app, sessionId: session.id, grant, login, call }
}

describe('session guest access', () => {
    it('exchanges the code for a guest token that regular auth never accepts', async () => {
        const { login, authService, sessionId } = setup()
        expect((await login('WRONG000')).status).toBe(401)

        const res = await login(` ${CODE.toLowerCase()} `)
        expect(res.status).toBe(200)
        const body = await res.json() as { token: string; guest: { sessionId: string; voiceEnabled: boolean } }
        expect(body.guest).toEqual({ sessionId, voiceEnabled: false })
        expect(res.headers.get('set-cookie')).toContain('hapi_guest=')
        expect(await authService.verifyJwt(body.token)).toBeNull()
    })

    it('only reaches the routes needed to interact with its session', async () => {
        const { login, call, sessionId } = setup()
        const { token } = await (await login(CODE)).json() as { token: string }

        const allowed: Array<[string, string]> = [
            ['GET', `/api/sessions/${sessionId}`],
            ['GET', `/api/sessions/${sessionId}/messages`],
            ['POST', `/api/sessions/${sessionId}/messages`],
            ['POST', `/api/sessions/${sessionId}/permissions/req-1/approve`],
            ['POST', `/api/sessions/${sessionId}/abort`],
            ['GET', `/api/events?sessionId=${sessionId}`],
            ['POST', '/api/visibility']
        ]
        for (const [method, path] of allowed) {
            const res = await call(token, method, path)
            expect([method, path, res.status]).toEqual([method, path, 200])
        }

        const denied: Array<[string, string]> = [
            ['GET', '/api/sessions'],
            ['GET', '/api/machines'],
            ['GET', '/api/preferences'],
            ['GET', '/api/sessions/other/messages'],
            ['GET', `/api/sessions/${sessionId}x/messages`],
            ['GET', `/api/sessions/${sessionId}/files`],
            ['GET', `/api/sessions/${sessionId}/usage`],
            ['POST', `/api/sessions/${sessionId}/share`],
            ['POST', `/api/sessions/${sessionId}/guest-grants`],
            ['POST', `/api/sessions/${sessionId}/permission-mode`],
            ['DELETE', `/api/sessions/${sessionId}`],
            ['GET', '/api/events?all=true'],
            ['GET', `/api/events?sessionId=${sessionId}&all=true`]
        ]
        for (const [method, path] of denied) {
            const res = await call(token, method, path)
            expect([method, path, res.status]).toEqual([method, path, 403])
        }
    })

    it('stops working as soon as the grant is revoked', async () => {
        const { login, call, store, sessionId, grant } = setup()
        const { token } = await (await login(CODE)).json() as { token: string }
        store.sessionGrants.revoke(grant.id, sessionId, 'default')
        expect((await call(token, 'GET', `/api/sessions/${sessionId}`)).status).toBe(401)
        expect((await login(CODE)).status).toBe(401)
    })

    it('locks the grant after repeated wrong codes', async () => {
        const { login } = setup()
        for (let i = 0; i < 10; i++) {
            await login('WRONG000')
        }
        expect((await login(CODE)).status).toBe(401)
    })
})
