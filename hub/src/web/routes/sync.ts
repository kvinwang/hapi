import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const messagesQuerySchema = z.object({
    since: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
    cursor: z.string().optional()
})

const sessionsQuerySchema = z.object({
    updatedSince: z.coerce.number().int().min(0).default(0)
})

export function createSyncRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sync/messages', (c) => {
        const parsed = messagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query parameters' }, 400)
        }

        const { since, limit, cursor } = parsed.data
        const result = store.messages.getMessagesSince(since, limit, cursor)

        return c.json({
            messages: result.messages.map((m) => ({
                id: m.id,
                sessionId: m.sessionId,
                seq: m.seq,
                content: m.content,
                createdAt: m.createdAt
            })),
            cursor: result.cursor,
            hasMore: result.hasMore
        })
    })

    app.get('/sync/sessions', (c) => {
        const parsed = sessionsQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query parameters' }, 400)
        }

        const { updatedSince } = parsed.data
        const allSessions = store.sessions.getSessions()

        const filtered = updatedSince > 0
            ? allSessions.filter((s) => s.updatedAt >= updatedSince)
            : allSessions

        return c.json({
            sessions: filtered.map((s) => {
                const metadata = s.metadata as Record<string, unknown> | null
                return {
                    id: s.id,
                    namespace: s.namespace,
                    metadata: metadata ? {
                        name: metadata.name ?? null,
                        path: metadata.path ?? null,
                        summary: metadata.summary ?? null,
                        flavor: metadata.flavor ?? null,
                        machineId: metadata.machineId ?? null,
                        worktree: metadata.worktree ?? null
                    } : null,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                    active: s.active
                }
            })
        })
    })

    return app
}
