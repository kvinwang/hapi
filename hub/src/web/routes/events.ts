import type { AuthService } from '../../auth/authService'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import type { VisibilityState } from '../../visibility/visibilityTracker'
import type { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession } from './guards'

function parseOptionalId(value: string | undefined): string | null {
    if (!value) {
        return null
    }
    return value.trim() ? value : null
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) {
        return false
    }
    return value === 'true' || value === '1'
}

function parseVisibility(value: string | undefined): VisibilityState {
    return value === 'visible' ? 'visible' : 'hidden'
}

const visibilitySchema = z.object({
    subscriptionId: z.string().min(1),
    visibility: z.enum(['visible', 'hidden'])
})

export function createEventsRoutes(
    getSseManager: () => SSEManager | null,
    getSyncEngine: () => SyncEngine | null,
    getVisibilityTracker: () => VisibilityTracker | null,
    authService?: AuthService
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/events', (c) => {
        const manager = getSseManager()
        if (!manager) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const query = c.req.query()
        const all = parseBoolean(query.all)
        const sessionId = parseOptionalId(query.sessionId)
        const machineId = parseOptionalId(query.machineId)
        const subscriptionId = randomUUID()
        const visibility = parseVisibility(query.visibility)
        const namespace = c.get('namespace')
        const requestedSessionIds = z.array(z.string().min(1)).max(100).safeParse(c.req.queries('sessionIds') ?? [])
        if (!requestedSessionIds.success) return c.json({ error: 'Invalid session subscriptions' }, 400)
        const sessionIds: string[] = []
        if (requestedSessionIds.data.length) {
            const engine = getSyncEngine()
            if (!engine) return c.json({ error: 'Not connected' }, 503)
            for (const id of requestedSessionIds.data) {
                const result = requireSession(c, engine, id)
                if (result instanceof Response) return result
                sessionIds.push(result.sessionId)
            }
        }
        let resolvedSessionId = sessionId

        if (sessionId || machineId) {
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not connected' }, 503)
            }
            if (sessionId) {
                const sessionResult = requireSession(c, engine, sessionId)
                if (sessionResult instanceof Response) {
                    return sessionResult
                }
                resolvedSessionId = sessionResult.sessionId
            }
            if (machineId) {
                const machine = engine.getMachine(machineId)
                if (!machine) {
                    return c.json({ error: 'Machine not found' }, 404)
                }
                if (machine.namespace !== namespace) {
                    return c.json({ error: 'Machine access denied' }, 403)
                }
            }
        }

        return streamSSE(c, async (stream) => {
            manager.subscribe({
                id: subscriptionId,
                namespace,
                all,
                sessionId: resolvedSessionId,
                sessionIds,
                machineId,
                visibility,
                send: async (event) => {
                    const allowed = c.get('guestEventAllowed')
                    if (allowed) {
                        if (!await allowed(resolvedSessionId)) { stream.abort(); return }
                        if (event.type === 'threads-updated') return
                        if ('sessionId' in event && event.sessionId !== resolvedSessionId) return
                    }
                    await stream.writeSSE({ data: JSON.stringify(event) })
                },
                sendHeartbeat: async () => {
                    const allowed = c.get('guestEventAllowed')
                    if (allowed && !await allowed(resolvedSessionId)) { stream.abort(); return }
                    await stream.writeSSE({
                        data: JSON.stringify({
                            type: 'heartbeat',
                            namespace,
                            data: {
                                timestamp: Date.now()
                            }
                        })
                    })
                }
            })

            await stream.writeSSE({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: {
                        status: 'connected',
                        subscriptionId
                    }
                })
            })

            let release: (() => void) | undefined
            let done: () => void = () => {}
            try {
                await new Promise<void>((resolve) => {
                    done = resolve
                    c.req.raw.signal.addEventListener('abort', done, { once: true })
                    stream.onAbort(done)
                    release = authService?.trackConnection(c.get('apiKeyId'), c.get('accessTokenId'), () => {
                        manager.unsubscribe(subscriptionId)
                        stream.abort()
                        done()
                    })
                    if (stream.aborted || c.req.raw.signal.aborted) done()
                })
            } finally {
                release?.()
                c.req.raw.signal.removeEventListener('abort', done)
                manager.unsubscribe(subscriptionId)
            }

        })
    })

    app.post('/visibility', async (c) => {
        const tracker = getVisibilityTracker()
        if (!tracker) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = visibilitySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const updated = tracker.setVisibility(parsed.data.subscriptionId, namespace, parsed.data.visibility)
        if (!updated) {
            return c.json({ error: 'Subscription not found' }, 404)
        }

        return c.json({ ok: true })
    })

    return app
}
