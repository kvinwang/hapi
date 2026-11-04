import { isObject } from '@hapi/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { SharedThreadMember, SharedThreadResponse, ThreadInbox } from '@hapi/protocol/threads'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().min(0).optional()
})

/** Public read-only projection. Never expose machine paths, member summaries, or read receipts. */
export function createThreadShareRoutes(store: Store): Hono {
    const app = new Hono()
    app.use('/share/threads/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('X-Robots-Tag', 'noindex, nofollow')
        c.header('Referrer-Policy', 'no-referrer')
        await next()
    })
    app.get('/share/threads/:token', c => {
        const shared = store.threads.getShared(c.req.param('token'))
        if (!shared) return c.json({ error: 'Shared thread not found' }, 404)
        const { thread, namespace } = shared
        const memberIds = new Map(store.threads.members(thread.id).map(member => [member.id, member.kind]))
        const members: SharedThreadMember[] = [...memberIds].map(([id, kind]) => {
            const metadata = kind === 'session' ? store.sessions.getSessionByNamespace(id, namespace)?.metadata : null
            const name = isObject(metadata) && typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : `Session ${id.slice(0, 8)}`
            return { id, kind, name: kind === 'user' ? 'User' : name }
        })
        const response: SharedThreadResponse = {
            thread: { id: thread.id, name: thread.name, description: thread.description, archived: thread.archived, createdAt: thread.createdAt },
            members
        }
        return c.json(response)
    })
    app.get('/share/threads/:token/messages', c => {
        const shared = store.threads.getShared(c.req.param('token'))
        if (!shared) return c.json({ error: 'Shared thread not found' }, 404)
        const parsed = querySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid pagination' }, 400)
        const { limit, after, before } = parsed.data
        const latest = after === undefined
        const rows = store.threads.history(shared.thread.id, after ?? 0, before ?? Number.MAX_SAFE_INTEGER, limit + 1, latest)
        const response: ThreadInbox = {
            messages: (latest ? rows.slice(-limit) : rows.slice(0, limit)).map(message => ({
                id: message.id, threadId: message.threadId, seq: message.seq, sender: message.sender,
                text: message.text, mentions: message.mentions, replyTo: message.replyTo,
                createdAt: message.createdAt, receipts: []
            })),
            hasMore: rows.length > limit
        }
        return c.json(response)
    })
    return app
}
