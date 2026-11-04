import { Hono } from 'hono'
import { z } from 'zod'
import { ThreadTagsSchema, ThreadSendSchema, type ThreadSender } from '@hapi/protocol/threads'
import { hasPermission } from '../../auth/permissions'
import type { Permission } from '../../store/types'
import type { SyncEngine } from '../../sync/syncEngine'
import { ThreadError } from '../../sync/threadService'

type ThreadEnv = { Variables: { namespace: string; permissions: Permission[] } }
const inboxQuery = z.object({
    threadId: z.string().uuid().optional(),
    mentions: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    wait: z.coerce.number().int().min(0).max(60).default(0)
})

export function createThreadRoutes(getEngine: () => SyncEngine | null, cli = false): Hono<ThreadEnv> {
    const app = new Hono<ThreadEnv>()
    app.use('*', async (c, next) => {
        if (!hasPermission(c.get('permissions'), c.req.method === 'GET' ? 'sessions:read' : 'sessions:write')) return c.json({ error: 'Insufficient permissions' }, 403)
        if (!getEngine()) return c.json({ error: 'Not ready' }, 503)
        return await next()
    })
    app.onError((error, c) => {
        if (error instanceof ThreadError) return c.json({ error: error.message }, error.status)
        if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid thread request', details: error.message }, 400)
        console.error('Thread request failed', error)
        return c.json({ error: 'Thread request failed' }, 500)
    })
    const actor = (id: string | undefined): ThreadSender => {
        if (!cli) return { kind: 'user' }
        if (!id) throw new ThreadError('HAPI_SESSION_ID is required; no anonymous thread operations')
        return { kind: 'session', sessionId: z.string().uuid().parse(id) }
    }
    app.get('/threads', c => {
        const service = getEngine()!.threads
        const filterSession = !cli ? c.req.query('sessionId') : undefined
        const sender: ThreadSender = filterSession ? { kind: 'session', sessionId: z.string().uuid().parse(filterSession) } : actor(c.req.query('sessionId'))
        const memberId = service.actor(sender, c.get('namespace'))
        const threads = service.store.threads.list(c.get('namespace'), cli || filterSession ? memberId : undefined)
        return c.json({ threads: threads.map(g => ({ ...g, unread: service.store.threads.unread(g.id, memberId) })) })
    })
    app.post('/threads', async c => {
        const input = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2_000).default(''), tags: ThreadTagsSchema.default([]) }).strict().parse(await c.req.json())
        const service = getEngine()!.threads
        const sender = actor(c.req.query('sessionId'))
        service.actor(sender, c.get('namespace'))
        const thread = service.store.threads.create(c.get('namespace'), input.name, input.description, sender, input.tags)
        service.changed(c.get('namespace'))
        return c.json({ thread })
    })
    app.get('/threads/context', c => {
        const service = getEngine()!.threads
        const sender = actor(c.req.query('sessionId'))
        const id = service.actor(sender, c.get('namespace'))
        return c.json(service.contextSnapshot(id, c.get('namespace')))
    })
    app.get('/threads/inbox', async c => {
        const options = inboxQuery.parse(c.req.query())
        return c.json(await getEngine()!.threads.inbox(c.get('namespace'), actor(c.req.query('sessionId')), options, c.req.raw.signal))
    })
    app.post('/threads/consume', async c => {
        const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100) }).strict().parse(await c.req.json())
        getEngine()!.threads.consume(c.get('namespace'), actor(c.req.query('sessionId')), ids)
        return c.json({ ok: true })
    })
    app.get('/threads/:id', c => {
        const service = getEngine()!.threads
        const thread = service.member(c.req.param('id'), c.get('namespace'), actor(c.req.query('sessionId')))
        return c.json({ thread, members: service.members(thread.id, c.get('namespace')) })
    })
    app.get('/threads/:id/share', c => {
        const service = getEngine()!.threads
        const id = c.req.param('id')
        const namespace = c.get('namespace')
        service.member(id, namespace, actor(c.req.query('sessionId')))
        c.header('Cache-Control', 'no-store')
        return c.json({ shareToken: service.store.threads.getShareToken(id, namespace) })
    })
    app.get('/threads/:id/history', c => {
        const service = getEngine()!.threads
        const id = c.req.param('id')
        service.member(id, c.get('namespace'), actor(c.req.query('sessionId')))
        const query = z.object({
            after: z.coerce.number().int().min(0).default(0),
            before: z.coerce.number().int().positive().default(Number.MAX_SAFE_INTEGER),
            limit: z.coerce.number().int().min(1).max(100).default(50)
        }).parse(c.req.query())
        const latest = c.req.query('after') === undefined
        const messages = service.store.threads.history(id, query.after, query.before, query.limit + 1, latest)
        return c.json({ messages: latest ? messages.slice(-query.limit) : messages.slice(0, query.limit), hasMore: messages.length > query.limit })
    })
    app.post('/threads/:id/send', async c => {
        const input = ThreadSendSchema.parse(await c.req.json())
        return c.json(await getEngine()!.threads.send(c.req.param('id'), c.get('namespace'), actor(c.req.query('sessionId')), input))
    })
    app.post('/threads/:id/:action', async c => {
        const service = getEngine()!.threads
        const id = c.req.param('id')
        const namespace = c.get('namespace')
        const sender = actor(c.req.query('sessionId'))
        const memberId = service.actor(sender, namespace)
        const action = c.req.param('action')
        if (action === 'join') service.add(id, namespace, sender)
        else {
            const thread = service.member(id, namespace, sender)
            if (action === 'share') {
                const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(await c.req.json())
                const shareToken = service.store.threads.setShared(id, namespace, enabled)
                service.changed(namespace)
                c.header('Cache-Control', 'no-store')
                return c.json({ shareToken })
            }
            if (action === 'tags') {
                const { tags } = z.object({ tags: ThreadTagsSchema }).strict().parse(await c.req.json())
                service.store.threads.setTags(id, namespace, tags)
            } else if (action === 'restore') service.store.threads.restore(id)
            else {
                service.writable(thread)
                if (action === 'add') {
                    const body = z.object({ sessionId: z.string().uuid() }).strict().parse(await c.req.json())
                    service.add(id, namespace, { kind: 'session', sessionId: body.sessionId })
                } else if (action === 'leave') service.store.threads.leave(id, memberId)
                else if (action === 'archive') service.store.threads.archive(id)
                else if (action === 'settings') {
                    const body = z.object({ mentionWake: z.boolean(), sessionId: z.string().uuid().optional() }).strict().parse(await c.req.json())
                    const target = !cli && body.sessionId ? body.sessionId : memberId
                    if (!service.store.threads.members(id).some(m => m.id === target)) throw new ThreadError('Member not found', 404)
                    service.store.threads.settings(id, target, body.mentionWake)
                } else throw new ThreadError('Unknown action', 404)
            }
            service.changed(c.get('namespace'))
        }
        return c.json({ ok: true, members: service.members(id, namespace) })
    })
    return app
}
