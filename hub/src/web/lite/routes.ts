/**
 * Routes for the low-power ("lite") UI.
 *
 * Server-rendered HTML with a ~3 KB inline script. Mounted alongside the React SPA on
 * the same hub, sharing its REST semantics and sync engine — the SPA at `/` is
 * untouched. See `render.ts` for the rendering constraints and why they exist.
 *
 * Auth is cookie-based so plain page navigations work: `hapi_lite` holds either a JWT
 * or a raw CLI/API token, both of which `AuthService` already understands.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { hasPermission } from '../../auth/permissions'
import type { Permission } from '../../store/types'
import type { AuthService } from '../../auth/authService'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { DecryptedMessage } from '@hapi/protocol/schemas'
import { LITE_CLIENT_JS } from './client'
import { buildAskAnswers, buildInputAnswers, parseAskQuestions, parseInputQuestions } from './questions'
import {
    LITE_BASE,
    layout,
    pendingRequestCount,
    renderLoginPage,
    renderTail,
    renderRequests,
    renderSessionListPage,
    renderSessionPage,
    requestsKey,
    renderStatus
} from './render'

const COOKIE = 'hapi_lite'
const COOKIE_MAX_AGE = 30 * 24 * 3600

/** Messages per page. Deliberately small: no virtualization, and Safari 17 lacks `content-visibility`. */
const PAGE_SIZE = 40
/** Cap on a single incremental tail, so a long catch-up cannot blow up the DOM. */
const TAIL_LIMIT = 40
const LIST_LIMIT = 60

type LiteEnv = {
    Variables: {
        namespace: string
        permissions: Permission[]
    }
}

function isArchived(session: Session): boolean {
    const meta = (session.metadata ?? null) as Record<string, unknown> | null
    return meta?.lifecycleState === 'archived'
}

function maxSeq(messages: DecryptedMessage[]): number {
    let max = 0
    for (const m of messages) {
        if (typeof m.seq === 'number' && m.seq > max) max = m.seq
    }
    return max
}

function minSeq(messages: DecryptedMessage[]): number | null {
    let min: number | null = null
    for (const m of messages) {
        if (typeof m.seq === 'number' && (min === null || m.seq < min)) min = m.seq
    }
    return min
}

/** Form posts come from real navigations unless the inline script marks them. */
function isFetchPost(c: Context): boolean {
    return c.req.header('x-lite-fetch') === '1'
}

function backTo(c: Context, sessionId: string, error?: string): Response {
    if (isFetchPost(c)) {
        return c.body(null, 204)
    }
    const suffix = error ? `?error=${encodeURIComponent(error)}` : ''
    return c.redirect(`${LITE_BASE}/s/${encodeURIComponent(sessionId)}${suffix}`, 303)
}

/**
 * Run an action that reaches the agent over RPC, reporting failure as readable text.
 *
 * These calls throw whenever the agent is not connected ("RPC handler not registered"),
 * which is routine — a laptop closed, a session ended. Left unhandled it surfaces as a
 * bare 500, and a browser without JS lands on a blank error page with no way back.
 */
async function attempt(c: Context, sessionId: string, action: () => Promise<unknown>): Promise<Response> {
    try {
        await action()
    } catch (error) {
        console.warn('[lite] action failed', error)
        return actionError(c, sessionId, '操作失败:agent 可能已断开连接。')
    }
    return backTo(c, sessionId)
}

function actionError(c: Context, sessionId: string, message: string): Response {
    if (isFetchPost(c)) {
        return c.json({ error: message }, 400)
    }
    return backTo(c, sessionId, message)
}

function createLiteAuth(authService: AuthService): MiddlewareHandler<LiteEnv> {
    return async (c, next) => {
        if (c.req.path === `${LITE_BASE}/login`) {
            await next()
            return
        }

        // `?token=` makes the app bookmarkable on a tablet: hit it once, get a cookie,
        // then redirect to a clean URL so the token stops living in history.
        //
        // `hapi_token` is the SPA's own session cookie, accepted last so that opening
        // `/lite` in a browser already logged into the SPA just works. It expires after
        // 4h, so the durable path is still `hapi_lite` — which the SPA's "low-power UI"
        // entry sets by posting its long-lived access token to `/lite/login`.
        const fromQuery = c.req.query('token')
        const token = fromQuery ?? getCookie(c, COOKIE) ?? getCookie(c, 'hapi_token')

        if (!token) {
            return c.html(renderLoginPage(), 401)
        }

        const identity = await resolveIdentity(authService, token)
        if (!identity) {
            return c.html(renderLoginPage('令牌无效或已过期,请重新登录。'), 401)
        }

        // `/lite` reaches the same engine as `/api`, so it must apply the same permission
        // floor — otherwise a read-only key rejected by `/api` could send messages,
        // approve permission prompts and abort sessions through here.
        const required: Permission = c.req.method === 'GET' ? 'sessions:read' : 'sessions:write'
        if (!hasPermission(identity.permissions, required)) {
            return c.html(errorPage('该令牌没有执行此操作的权限。'), 403)
        }

        if (fromQuery) {
            writeCookie(c, token)
            const url = new URL(c.req.url)
            url.searchParams.delete('token')
            return c.redirect(`${url.pathname}${url.search}`, 303)
        }

        c.set('namespace', identity.namespace)
        c.set('permissions', identity.permissions)
        await next()
        return
    }
}

type LiteIdentity = { namespace: string; permissions: Permission[] }

async function resolveIdentity(authService: AuthService, token: string): Promise<LiteIdentity | null> {
    const jwt = await authService.verifyJwt(token)
    if (jwt) return { namespace: jwt.namespace, permissions: jwt.permissions }
    const cli = authService.authenticateCliToken(token)
    return cli ? { namespace: cli.namespace, permissions: cli.permissions } : null
}

function writeCookie(c: Context, token: string): void {
    setCookie(c, COOKIE, token, {
        httpOnly: true,
        // Derived from how this request actually arrived, not from `publicUrl`: an https
        // public URL reached over plain http on the LAN would otherwise set a Secure
        // cookie the browser drops, producing a login loop with no way out.
        secure: requestIsSecure(c),
        sameSite: 'Lax',
        // Site-wide, not `/lite`: the EventSource talks to `/api/events`, which never
        // receives a `Path=/lite` cookie.
        path: '/',
        maxAge: COOKIE_MAX_AGE
    })
}

/**
 * Whether a mutating request came from another site.
 *
 * Compares hosts, not full origins. The hub normally sits behind a TLS-terminating
 * proxy, so the browser sends `Origin: https://host` while the request URL the server
 * sees is `http://host` — comparing origins rejects every genuine POST from the page
 * itself. The host is what an attacker cannot forge, and it is the part the proxy
 * preserves (`proxy_set_header Host $host`).
 *
 * A missing Origin is treated as same-site: browsers send it on every cross-origin
 * form post, and a client that sends none carries no ambient cookie to abuse.
 */
function isCrossSite(c: Context): boolean {
    const origin = c.req.header('origin')
    if (!origin) return false

    let originHost: string
    try {
        originHost = new URL(origin).host
    } catch {
        // Unparseable Origin (including the literal "null" of an opaque origin).
        return true
    }

    const host = c.req.header('host') ?? new URL(c.req.url).host
    return originHost !== host
}

function requestIsSecure(c: Context): boolean {
    const forwarded = c.req.header('x-forwarded-proto')
    if (forwarded) return forwarded.split(',')[0].trim() === 'https'
    return new URL(c.req.url).protocol === 'https:'
}

export function createLiteRoutes(
    getSyncEngine: () => SyncEngine | null,
    authService: AuthService
): Hono<LiteEnv> {
    const app = new Hono<LiteEnv>()

    // Runs ahead of everything, login included. SameSite=Lax already blocks cross-site
    // posts that rely on an existing cookie, but /lite/login needs no cookie — it *sets*
    // one. Without this, a page anywhere could auto-submit a form that plants an
    // attacker's token as a 30-day cookie, quietly moving the tablet into their
    // namespace. Only a present-and-foreign Origin is rejected, so non-browser clients,
    // which have no ambient credentials to abuse, are unaffected.
    app.use('*', async (c, next) => {
        if (c.req.method === 'GET' || c.req.method === 'HEAD') {
            await next()
            return
        }
        if (isCrossSite(c)) {
            return c.text('Cross-site request rejected', 403)
        }
        await next()
        return
    })

    app.get('/login', (c) => c.html(renderLoginPage()))

    app.post('/login', async (c) => {
        const body = await c.req.parseBody().catch(() => null)
        const token = typeof body?.token === 'string' ? body.token.trim() : ''
        if (!token) {
            return c.html(renderLoginPage('请填写令牌。'), 400)
        }
        const identity = await resolveIdentity(authService, token)
        if (!identity) {
            return c.html(renderLoginPage('令牌无效。'), 401)
        }
        if (!hasPermission(identity.permissions, 'sessions:read')) {
            return c.html(renderLoginPage('该令牌没有读取会话的权限。'), 403)
        }
        writeCookie(c, token)
        return c.redirect(LITE_BASE, 303)
    })

    app.use('*', createLiteAuth(authService))

    /** Session list. */
    app.get('/', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.html(errorPage('Hub 尚未连接'), 503)

        const showArchived = c.req.query('archived') === '1'
        const sessions = engine.getSessionsByNamespace(c.get('namespace'))
            .filter((s) => showArchived || !isArchived(s))
            .sort((a, b) => {
                if (a.active !== b.active) return a.active ? -1 : 1
                const ap = pendingRequestCount(a)
                const bp = pendingRequestCount(b)
                if (a.active && ap !== bp) return bp - ap
                return b.updatedAt - a.updatedAt
            })
            .slice(0, LIST_LIMIT)

        return c.html(renderSessionListPage(sessions, Date.now()))
    })

    /** Session chat. */
    app.get('/s/:id', (c) => {
        const resolved = resolve(c, getSyncEngine)
        if (resolved instanceof Response) return resolved
        const { engine, session } = resolved

        const beforeRaw = c.req.query('before')
        const parsedBefore = beforeRaw ? Number.parseInt(beforeRaw, 10) : Number.NaN
        const before = Number.isFinite(parsedBefore) && parsedBefore > 0 ? parsedBefore : null

        // Tailing a historical page would splice every newer message onto the end of
        // the window being read, so history is always static; the page offers a way back.
        const live = before === null && c.req.query('live') !== '0'

        const page = engine.getMessagesPage(session.id, {
            limit: PAGE_SIZE,
            beforeSeq: before,
            afterSeq: null,
            toolGroups: false
        })

        return c.html(renderSessionPage({
            session,
            messages: page.messages,
            lastSeq: maxSeq(page.messages),
            hasMore: page.page.hasMore,
            oldestSeq: minSeq(page.messages),
            live,
            historical: before !== null,
            error: c.req.query('error') ?? undefined,
            script: LITE_CLIENT_JS
        }))
    })

    /**
     * Incremental update. Returns new messages plus the current status and permission
     * requests — the latter two live in `agentState`, not the message stream, so they
     * would otherwise never reach a page that only appends messages.
     */
    app.get('/s/:id/tail', (c) => {
        const resolved = resolve(c, getSyncEngine)
        if (resolved instanceof Response) return resolved
        const { engine, session } = resolved

        const afterRaw = c.req.query('afterSeq')
        const afterSeq = afterRaw ? Number.parseInt(afterRaw, 10) : 0
        const page = engine.getMessagesPage(session.id, {
            limit: TAIL_LIMIT,
            beforeSeq: null,
            afterSeq: Number.isFinite(afterSeq) && afterSeq > 0 ? afterSeq : 0,
            toolGroups: false
        })

        return c.json({
            html: page.messages.length > 0 ? renderTail(page.messages) : '',
            lastSeq: Math.max(maxSeq(page.messages), Number.isFinite(afterSeq) ? afterSeq : 0),
            // The client keeps pulling while this is set, otherwise a catch-up longer
            // than one batch would truncate silently.
            hasMore: page.page.hasMore,
            statusHtml: renderStatus(session),
            requestsHtml: renderRequests(session),
            // The client swaps the request block only when this changes, so a partly
            // filled answer form survives the poll.
            requestsKey: requestsKey(session)
        })
    })

    app.post('/s/:id/send', async (c) => {
        const resolved = resolve(c, getSyncEngine)
        if (resolved instanceof Response) return resolved
        const { engine, session } = resolved

        if (!session.active) {
            return actionError(c, session.id, '会话已断开,无法发送。')
        }

        const body = await c.req.parseBody().catch(() => null)
        const text = typeof body?.text === 'string' ? body.text : ''
        if (!text.trim()) {
            return actionError(c, session.id, '消息为空。')
        }

        return await attempt(c, session.id, () => engine.sendMessage(session.id, { text, sentFrom: 'webapp' }))
    })

    app.post('/s/:id/permission/:requestId', async (c) => {
        const resolved = resolve(c, getSyncEngine)
        if (resolved instanceof Response) return resolved
        const { engine, session } = resolved

        const requestId = c.req.param('requestId')
        const request = session.agentState?.requests?.[requestId]
        if (!request) {
            return actionError(c, session.id, '该请求已不存在。')
        }

        // `all: true` so repeated field names (a multi-select question) arrive as arrays
        // rather than collapsing to whichever value happened to come last.
        const body = await c.req.parseBody({ all: true }).catch(() => null)
        const field = (name: string): string[] => {
            const value = body?.[name]
            if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
            return typeof value === 'string' ? [value] : []
        }
        const single = (name: string): string => field(name)[0] ?? ''

        const decision = single('decision')
        if (decision === 'denied') {
            return await attempt(c, session.id, () => engine.denyPermission(session.id, requestId, 'denied'))
        }

        // Question tools are answered, not approved. The questions are re-parsed from the
        // live request rather than trusted from the form, so a stale or forged submission
        // cannot invent answer keys.
        const kind = single('kind')
        if (kind === 'ask' || kind === 'input') {
            const answers = kind === 'ask'
                ? buildAskAnswers(
                    parseAskQuestions(request.arguments),
                    (index) => ({ selected: field(`q${index}`), other: single(`q${index}_other`) })
                )
                : buildInputAnswers(
                    parseInputQuestions(request.arguments),
                    (id) => ({ selected: single(`a_${id}`), note: single(`n_${id}`) })
                )

            // An empty set makes the agent side deny with "No answers were provided",
            // which reads as a refusal rather than the missed tap it actually was.
            if (Object.keys(answers).length === 0) {
                return actionError(c, session.id, '请至少回答一个问题。')
            }

            return await attempt(c, session.id, () =>
                engine.approvePermission(session.id, requestId, undefined, undefined, undefined, answers))
        }

        if (decision === 'approved' || decision === 'approved_for_session') {
            return await attempt(c, session.id, () =>
                engine.approvePermission(session.id, requestId, undefined, undefined, decision))
        }

        return actionError(c, session.id, '无效的操作。')
    })

    app.post('/s/:id/abort', async (c) => {
        const resolved = resolve(c, getSyncEngine)
        if (resolved instanceof Response) return resolved
        const { engine, session } = resolved

        return await attempt(c, session.id, async () => {
            engine.forceSessionIdle(session.id, {
                active: session.active ? true : undefined,
                time: Date.now()
            })
            // Local state is already reset, so a failed RPC is not worth surfacing.
            void engine.abortSession(session.id).catch((error) => {
                console.warn('[lite.abort] RPC abort failed; session state was reset locally', error)
            })
        })
    })

    return app
}

function errorPage(message: string): string {
    return layout({
        title: 'HAPI 省电版',
        body: `<header><h1>HAPI 省电版</h1></header><div class="err-box">${message}</div>`
    })
}

function resolve(
    c: Context<LiteEnv>,
    getSyncEngine: () => SyncEngine | null
): { engine: SyncEngine; session: Session } | Response {
    const engine = getSyncEngine()
    if (!engine) return c.html(errorPage('Hub 尚未连接'), 503)

    const access = engine.resolveSessionAccess(c.req.param('id'), c.get('namespace'))
    if (!access.ok) {
        const denied = access.reason === 'access-denied'
        return c.html(errorPage(denied ? '无权访问该会话' : '会话不存在'), denied ? 403 : 404)
    }
    return { engine, session: access.session }
}
