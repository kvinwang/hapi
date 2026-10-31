import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import { recentConversation, turnReply } from '../../sync/voiceText'
import { extractMessageEventType } from '../../notifications/eventParsing'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession, requireSyncEngine } from './guards'

const TOKEN_TTL_SECONDS = 1800
/** A reply poll returns `working` after this long; the browser polls again (proxies cut long requests). */
const REPLY_WAIT_MS = 45_000

const sessionBodySchema = z.object({ sessionId: z.string().min(1) })
const replyQuerySchema = z.object({ sessionId: z.string().min(1), afterSeq: z.coerce.number().int().min(0) })

/**
 * Voice conversation with Qwen Omni runs in the browser. The hub keeps the DashScope key: it mints short-lived
 * tokens (the browser reaches DashScope through HAPI_OMNI_RELAY_URL, a relay that moves the token into the
 * Authorization header, or else through the hub's /omni socket pipe), and it tells the browser what the agent
 * replied once a turn ends.
 */
export function createOmniVoiceRoutes(getSyncEngine: () => SyncEngine | null, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/voice/omni/session', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const parsed = sessionBodySchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const access = requireSession(c, engine, parsed.data.sessionId)
        if (access instanceof Response) return access

        const apiKey = store.preferences.get(c.get('namespace'), 'dashscopeApiKey')
        if (!apiKey) return c.json({ error: 'notConfigured' }, 400)
        const response = await fetch(`https://dashscope.aliyuncs.com/api/v1/tokens?expire_in_seconds=${TOKEN_TTL_SECONDS}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` }
        })
        const minted = await response.json().catch(() => null) as { token?: string; expires_at?: number } | null
        if (!response.ok || !minted?.token) return c.json({ error: 'DashScope token request failed' }, 502)

        const metadata = access.session.metadata
        return c.json({
            token: minted.token,
            expiresAt: minted.expires_at ?? null,
            relayUrl: process.env.HAPI_OMNI_RELAY_URL || null,
            title: metadata?.name || metadata?.summary?.text || metadata?.path || '',
            context: recentConversation(engine, access.sessionId)
        })
    })

    app.get('/voice/omni/reply', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const parsed = replyQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
        const access = requireSession(c, engine, parsed.data.sessionId)
        if (access instanceof Response) return access
        const { sessionId } = access
        const { afterSeq } = parsed.data

        const ready = () => turnReply(engine, sessionId, afterSeq)
        let reply = ready()
        if (reply === null) {
            reply = await new Promise<string | null>((resolve) => {
                const timer = setTimeout(() => finish(null), REPLY_WAIT_MS)
                const unsubscribe = engine.subscribe((event) => {
                    if (event.type === 'message-received' && event.sessionId === sessionId && extractMessageEventType(event) === 'ready') {
                        finish(ready())
                    }
                })
                c.req.raw.signal.addEventListener('abort', () => finish(null))
                function finish(value: string | null) {
                    clearTimeout(timer)
                    unsubscribe()
                    resolve(value)
                }
            })
        }
        return c.json(reply === null ? { status: 'working' } : { status: 'done', reply })
    })

    // Diagnostics from the browser's voice conversation (mic health, reconnects), for the hub log.
    app.post('/voice/omni/log', async (c) => {
        const body = await c.req.json().catch(() => null) as { event?: unknown; detail?: unknown } | null
        console.log(`[omni-client] ${String(body?.event ?? '').slice(0, 40)} ${String(body?.detail ?? '').slice(0, 300)}`)
        return c.json({ ok: true })
    })

    return app
}
