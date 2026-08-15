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
        forceSessionIdle: () => undefined,
        abortSession: async () => undefined,
        denyPermission: async () => undefined,
        approvePermission: async () => undefined,
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

describe('lite question answering', () => {
    const cookie = { cookie: 'hapi_lite=valid-cli-token' }

    type ApproveCall = {
        requestId: string
        mode: unknown
        allowTools: unknown
        decision: unknown
        answers: unknown
    }

    function questionApp(tool: string, args: unknown) {
        const calls: ApproveCall[] = []
        const withRequest = {
            ...SESSION,
            agentState: { requests: { 'req-1': { tool, arguments: args } } }
        } as Session

        const engine = stubEngine({
            resolveSessionAccess: ((sessionId: string) => ({ ok: true, sessionId, session: withRequest })) as never,
            approvePermission: (async (
                _sid: string, requestId: string, mode: unknown, allowTools: unknown, decision: unknown, answers: unknown
            ) => { calls.push({ requestId, mode, allowTools, decision, answers }) }) as never
        })

        return { app: makeApp(stubAuth(), engine), calls, session: withRequest }
    }

    const ASK_ARGS = {
        questions: [
            { header: 'Storage', question: 'Which backend?', options: [{ label: 'Redis' }, { label: 'SQLite' }] },
            { question: 'Extras?', multiSelect: true, options: [{ label: 'Metrics' }, { label: 'Tracing' }] }
        ]
    }

    const post = (app: ReturnType<typeof makeApp>, body: string) => app.request('/lite/s/s1/permission/req-1', {
        method: 'POST',
        headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-lite-fetch': '1' },
        body
    })

    it('submits AskUserQuestion answers keyed by question index', async () => {
        const { app, calls } = questionApp('AskUserQuestion', ASK_ARGS)
        const res = await post(app, 'kind=ask&q0=Redis&q1=Metrics&q1=Tracing')

        expect(res.status).toBe(204)
        expect(calls[0].answers).toEqual({ '0': ['Redis'], '1': ['Metrics', 'Tracing'] })
        // Question tools carry answers only; a mode here would change the session's
        // permission mode as a side effect, and decision is Codex-only.
        expect(calls[0].mode).toBeUndefined()
        expect(calls[0].allowTools).toBeUndefined()
        expect(calls[0].decision).toBeUndefined()
    })

    it('carries free text through as an extra answer', async () => {
        const { app, calls } = questionApp('AskUserQuestion', ASK_ARGS)
        await post(app, 'kind=ask&q0_other=Postgres')
        expect(calls[0].answers).toEqual({ '0': ['Postgres'] })
    })

    it('submits request_user_input answers keyed by id, with the note convention', async () => {
        const { app, calls } = questionApp('request_user_input', {
            questions: [
                { id: 'backend', question: 'Which?', options: [{ label: 'Redis' }] },
                { id: 'notes', question: 'Anything else?', options: [] }
            ]
        })
        await post(app, 'kind=input&a_backend=Redis&n_backend=keep+TLS+on&n_notes=ship+Friday')

        expect(calls[0].answers).toEqual({
            backend: { answers: ['Redis', 'user_note: keep TLS on'] },
            notes: { answers: ['user_note: ship Friday'] }
        })
    })

    it('rejects an empty submission instead of sending a silent refusal', async () => {
        // Empty answers make the agent side deny with "No answers were provided", which
        // reads as a decision the user never made.
        const { app, calls } = questionApp('AskUserQuestion', ASK_ARGS)
        const res = await post(app, 'kind=ask')

        expect(res.status).toBe(400)
        expect(calls).toHaveLength(0)
    })

    it('ignores answer values that are not offered options', async () => {
        const { app, calls } = questionApp('AskUserQuestion', ASK_ARGS)
        await post(app, 'kind=ask&q0=Redis&q0=smuggled')
        expect(calls[0].answers).toEqual({ '0': ['Redis'] })
    })

    it('still allows skipping a question request outright', async () => {
        const denied: string[] = []
        const withRequest = {
            ...SESSION,
            agentState: { requests: { 'req-1': { tool: 'AskUserQuestion', arguments: ASK_ARGS } } }
        } as Session
        const engine = stubEngine({
            resolveSessionAccess: ((sessionId: string) => ({ ok: true, sessionId, session: withRequest })) as never,
            denyPermission: (async (_s: string, id: string) => { denied.push(id) }) as never
        })
        const res = await makeApp(stubAuth(), engine).request('/lite/s/s1/permission/req-1', {
            method: 'POST',
            headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-lite-fetch': '1' },
            body: 'decision=denied'
        })
        expect(res.status).toBe(204)
        expect(denied).toEqual(['req-1'])
    })
})

describe('lite action failures', () => {
    const cookie = { cookie: 'hapi_lite=valid-cli-token' }

    /** The agent side throws exactly this when the CLI is not connected. */
    const disconnected = () => { throw new Error('RPC handler not registered: s1:permission') }

    it('reports a disconnected agent instead of a bare 500', async () => {
        const engine = stubEngine({ sendMessage: (async () => disconnected()) as never })
        const res = await makeApp(stubAuth(), engine).request('/lite/s/s1/send', {
            method: 'POST',
            headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-lite-fetch': '1' },
            body: 'text=hello'
        })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error: string }).error).toContain('断开')
    })

    it('redirects a no-JS submission back to a readable page rather than an error page', async () => {
        const engine = stubEngine({ sendMessage: (async () => disconnected()) as never })
        const res = await makeApp(stubAuth(), engine).request('/lite/s/s1/send', {
            method: 'POST',
            headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'text=hello'
        })
        expect(res.status).toBe(303)
        expect(res.headers.get('location')).toContain('/lite/s/s1?error=')
    })
})

describe('lite CSRF guard', () => {
    it('rejects a cross-site login post that would plant an attacker token', async () => {
        // /lite/login needs no cookie — it sets one — so SameSite does not protect it.
        const res = await makeApp(stubAuth()).request('/lite/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
            body: 'token=valid-cli-token'
        })
        expect(res.status).toBe(403)
        expect(res.headers.get('set-cookie')).toBeNull()
    })

    it('rejects a cross-site action post', async () => {
        const res = await makeApp(stubAuth()).request('/lite/s/s1/abort', {
            method: 'POST',
            headers: { cookie: 'hapi_lite=valid-cli-token', origin: 'https://evil.example' }
        })
        expect(res.status).toBe(403)
    })

    it('allows a same-origin post', async () => {
        const res = await makeApp(stubAuth()).request('http://hub.local/lite/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://hub.local' },
            body: 'token=valid-cli-token'
        })
        expect(res.status).toBe(303)
    })

    it('allows a post from the page when TLS is terminated by a proxy', async () => {
        // The regression this guard originally shipped with: behind nginx the browser
        // sends Origin: https://host while the server sees http://host, so comparing
        // full origins rejected every genuine send, approval and abort in production.
        const res = await makeApp(stubAuth()).request('http://hapi.example/lite/s/s1/abort', {
            method: 'POST',
            headers: {
                cookie: 'hapi_lite=valid-cli-token',
                host: 'hapi.example',
                origin: 'https://hapi.example',
                'x-forwarded-proto': 'https',
                'x-lite-fetch': '1'
            }
        })
        expect(res.status).toBe(204)
    })

    it('still rejects a foreign host over the same scheme', async () => {
        const res = await makeApp(stubAuth()).request('http://hapi.example/lite/s/s1/abort', {
            method: 'POST',
            headers: {
                cookie: 'hapi_lite=valid-cli-token',
                host: 'hapi.example',
                origin: 'https://evil.example'
            }
        })
        expect(res.status).toBe(403)
    })

    it('rejects an opaque (null) origin', async () => {
        const res = await makeApp(stubAuth()).request('http://hapi.example/lite/s/s1/abort', {
            method: 'POST',
            headers: { cookie: 'hapi_lite=valid-cli-token', host: 'hapi.example', origin: 'null' }
        })
        expect(res.status).toBe(403)
    })

    it('allows a client that sends no Origin at all', async () => {
        // curl and friends carry no ambient credentials, so there is nothing to forge.
        const res = await makeApp(stubAuth()).request('/lite/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'token=valid-cli-token'
        })
        expect(res.status).toBe(303)
    })

    it('never blocks reads', async () => {
        const res = await makeApp(stubAuth()).request('/lite', {
            headers: { cookie: 'hapi_lite=valid-cli-token', origin: 'https://evil.example' }
        })
        expect(res.status).toBe(200)
    })
})
