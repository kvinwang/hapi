import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { AttachmentMetadataSchema } from '@hapi/protocol/schemas'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
    role: z.enum(['user', 'assistant', 'tool']).optional(),
    toolGroups: z.enum(['0', '1']).optional()
})

const toolGroupQuerySchema = z.object({
    firstSeq: z.coerce.number().int().min(1),
    lastSeq: z.coerce.number().int().min(1)
})

const sendMessageBodySchema = z.object({
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional()
})

const trimMessagesBodySchema = z.object({
    mode: z.enum(['before', 'after', 'single']),
    seq: z.coerce.number().int().min(0)
})

const userMessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50_000).optional()
})

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/sessions/:id/messages', compress())
    app.use('/sessions/:id/user-messages', compress())
    app.use('/sessions/:id/tool-group-messages', compress())

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = querySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }
        if (parsed.data.beforeSeq !== undefined && parsed.data.afterSeq !== undefined) {
            return c.json({ error: 'beforeSeq and afterSeq cannot be used together' }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const beforeSeq = parsed.data.beforeSeq ?? null
        const afterSeq = parsed.data.afterSeq ?? null
        const role = parsed.data.role ?? undefined
        const toolGroups = parsed.data.toolGroups === '1'
        return c.json(engine.getMessagesPage(sessionId, { limit, beforeSeq, afterSeq, role, toolGroups }))
    })

    app.get('/sessions/:id/tool-group-messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult
        const parsed = toolGroupQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
        return c.json({
            messages: engine.getToolGroupMessages(sessionResult.sessionId, parsed.data)
        })
    })

    app.get('/sessions/:id/user-messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult
        const parsed = userMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
        return c.json(engine.getUserMessageHistory(sessionResult.sessionId, parsed.data.limit ?? 10_000))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = sendMessageBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            sentFrom: 'webapp'
        })
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/messages/trim', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = trimMessagesBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = engine.trimMessages(sessionId, parsed.data)
        return c.json({ ok: true, deleted: result.deleted })
    })

    return app
}
