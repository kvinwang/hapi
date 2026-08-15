import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { AuthService } from '../../auth/authService'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { Permission } from '../../store/types'
import { createLiteRoutes } from './routes'

/**
 * Auth is the part of the lite UI most likely to break silently: it is the only place
 * in the codebase that authenticates a browser navigation from a cookie, and getting it
 * wrong either locks the tablet out or — worse — lets a read-only token drive sessions.
 */

const SESSION: Session = {
    id: 's1',
    namespace: 'default',
    seq: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    active: true,
    activeAt: 1_700_000_000_000,
    metadata: { path: '/repo/demo', host: 'h' },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0
} as Session

function stubEngine(overrides: Partial<SyncEngine> = {}): SyncEngine {
    return {
        getSessionsByNamespace: () => [SESSION],
        resolveSessionAccess: (sessionId: string) => ({ ok: true, sessionId, session: SESSION }),
        getMessagesPage: () => ({
            messages: [],
            page: { limit: 40, beforeSeq: null, nextBeforeSeq: null, afterSeq: null, nextAfterSeq: null, hasMore: false }
        }),
        sendMessage: async () => undefined,
        ...overrides
    } as unknown as SyncEngine
}

/** Accepts `valid-*` tokens; everything else fails, as a real AuthService would. */
function stubAuth(permissions: Permission[] = ['admin']): AuthService {
    return {
        verifyJwt: async (token: string) =>
            token.startsWith('valid-jwt') ? { namespace: 'default', permissions } : null,
        authenticateCliToken: (token: string) =>
            token.startsWith('valid-cli') ? { namespace: 'default', permissions } : null
    } as unknown as AuthService
}

function makeApp(auth: AuthService, engine: SyncEngine = stubEngine()) {
    const app = new Hono()
    app.route('/lite', createLiteRoutes(() => engine, auth))
    return app
}

describe('lite auth', () => {
    it('shows the login page instead of a JSON 401 when unauthenticated', async () => {
        const res = await makeApp(stubAuth()).request('/lite')
        expect(res.status).toBe(401)
        expect(res.headers.get('content-type')).toContain('text/html')
        expect(await res.text()).toContain('访问令牌')
    })

    it('accepts its own hapi_lite cookie', async () => {
        const res = await makeApp(stubAuth()).request('/lite', {
            headers: { cookie: 'hapi_lite=valid-cli-token' }
        })
        expect(res.status).toBe(200)
    })

    it('reuses the SPA session via the hapi_token cookie', async () => {
        // Reuse means opening /lite in a browser already logged into the SPA just works.
        const res = await makeApp(stubAuth()).request('/lite', {
            headers: { cookie: 'hapi_token=valid-jwt-abc' }
        })
        expect(res.status).toBe(200)
        expect(await res.text()).not.toContain('访问令牌')
    })

    it('prefers its own cookie over the SPA one', async () => {
        const res = await makeApp(stubAuth()).request('/lite', {
            headers: { cookie: 'hapi_lite=valid-cli-token; hapi_token=bogus' }
        })
        expect(res.status).toBe(200)
    })

    it('rejects an invalid token with the login page', async () => {
        const res = await makeApp(stubAuth()).request('/lite', {
            headers: { cookie: 'hapi_lite=nope' }
        })
        expect(res.status).toBe(401)
        expect(await res.text()).toContain('令牌无效')
    })

    it('exchanges ?token= for a site-wide cookie and redirects to a clean URL', async () => {
        const res = await makeApp(stubAuth()).request('/lite?token=valid-cli-token')
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toBe('/lite')
        const cookie = res.headers.get('set-cookie') ?? ''
        // Path=/ matters: the EventSource talks to /api/events, outside /lite.
        expect(cookie).toContain('Path=/')
        expect(cookie).not.toContain('Path=/lite')
        expect(cookie).toContain('HttpOnly')
    })

    it('sets a durable cookie from a form login, for the SPA handoff', async () => {
        const res = await makeApp(stubAuth()).request('/lite/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'token=valid-cli-token'
        })
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toBe('/lite')
        expect(res.headers.get('set-cookie')).toContain('Max-Age=2592000')
    })

    it('does not mark the cookie Secure on a plain-http origin', async () => {
        // A Secure cookie over http is silently dropped, which would loop the login forever.
        const res = await makeApp(stubAuth()).request('http://box.local/lite?token=valid-cli-token')
        expect(res.headers.get('set-cookie')).not.toContain('Secure')
    })

    it('marks the cookie Secure behind an https proxy', async () => {
        const res = await makeApp(stubAuth()).request('http://box.local/lite?token=valid-cli-token', {
            headers: { 'x-forwarded-proto': 'https' }
        })
        expect(res.headers.get('set-cookie')).toContain('Secure')
    })
})

describe('lite permissions', () => {
    const readOnly = () => stubAuth(['sessions:read'])
    const cookie = { cookie: 'hapi_lite=valid-cli-token' }

    it('lets a read-only token read', async () => {
        const res = await makeApp(readOnly()).request('/lite', { headers: cookie })
        expect(res.status).toBe(200)
    })

    it('stops a read-only token from sending a message', async () => {
        // /lite reaches the same engine as /api; without this it is a privilege escalation.
        const res = await makeApp(readOnly()).request('/lite/s/s1/send', {
            method: 'POST',
            headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'text=hello'
        })
        expect(res.status).toBe(403)
    })

    it('stops a read-only token from approving a permission request', async () => {
        const res = await makeApp(readOnly()).request('/lite/s/s1/permission/r1', {
            method: 'POST',
            headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'decision=approved'
        })
        expect(res.status).toBe(403)
    })

    it('stops a read-only token from aborting a session', async () => {
        const res = await makeApp(readOnly()).request('/lite/s/s1/abort', {
            method: 'POST',
            headers: cookie
        })
        expect(res.status).toBe(403)
    })

    it('refuses to log in a token that cannot even read', async () => {
        const res = await makeApp(stubAuth([])).request('/lite/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'token=valid-cli-token'
        })
        expect(res.status).toBe(403)
    })

    it('lets a write-capable token through to the handler', async () => {
        const sent: string[] = []
        const engine = stubEngine({
            sendMessage: (async (_id: string, payload: { text: string }) => { sent.push(payload.text) }) as never
        })
        const app = makeApp(stubAuth(['sessions:read', 'sessions:write']), engine)
        const res = await app.request('/lite/s/s1/send', {
            method: 'POST',
            headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-lite-fetch': '1' },
            body: 'text=hello'
        })
        expect(res.status).toBe(204)
        expect(sent).toEqual(['hello'])
    })
})
