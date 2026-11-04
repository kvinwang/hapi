import { Hono } from 'hono'
import { z } from 'zod'
import { GroupSendSchema, type GroupSender } from '@hapi/protocol/groups'
import { hasPermission } from '../../auth/permissions'
import type { Permission } from '../../store/types'
import type { SyncEngine } from '../../sync/syncEngine'
import { GroupError } from '../../sync/groupService'

type GroupEnv = { Variables: { namespace: string; permissions: Permission[] } }
const inboxQuery = z.object({
    groupId: z.string().uuid().optional(),
    mentions: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    wait: z.coerce.number().int().min(0).max(60).default(0)
})

export function createGroupRoutes(getEngine: () => SyncEngine | null, cli = false): Hono<GroupEnv> {
    const app = new Hono<GroupEnv>()
    app.use('*', async (c, next) => {
        if (!hasPermission(c.get('permissions'), c.req.method === 'GET' ? 'sessions:read' : 'sessions:write')) return c.json({ error: 'Insufficient permissions' }, 403)
        if (!getEngine()) return c.json({ error: 'Not ready' }, 503)
        return await next()
    })
    app.onError((error, c) => {
        if (error instanceof GroupError) return c.json({ error: error.message }, error.status)
        if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid group request', details: error.message }, 400)
        console.error('Group request failed', error)
        return c.json({ error: 'Group request failed' }, 500)
    })
    const actor = (id: string | undefined): GroupSender => {
        if (!cli) return { kind: 'user' }
        if (!id) throw new GroupError('HAPI_SESSION_ID is required; no anonymous group operations')
        return { kind: 'session', sessionId: z.string().uuid().parse(id) }
    }
    app.get('/groups', c => {
        const service = getEngine()!.groups
        const sender = actor(c.req.query('sessionId'))
        const memberId = service.actor(sender, c.get('namespace'))
        const groups = service.store.groups.list(c.get('namespace'), cli ? memberId : undefined)
        return c.json({ groups: groups.map(g => ({ ...g, unread: service.store.groups.unread(g.id, memberId) })) })
    })
    app.post('/groups', async c => {
        const input = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2_000).default('') }).strict().parse(await c.req.json())
        const service = getEngine()!.groups
        const sender = actor(c.req.query('sessionId'))
        service.actor(sender, c.get('namespace'))
        const group = service.store.groups.create(c.get('namespace'), input.name, input.description, sender)
        service.changed(c.get('namespace'))
        return c.json({ group })
    })
    app.get('/groups/context', c => {
        const service = getEngine()!.groups
        const sender = actor(c.req.query('sessionId'))
        const id = service.actor(sender, c.get('namespace'))
        return c.json(service.contextSnapshot(id, c.get('namespace')))
    })
    app.get('/groups/inbox', async c => {
        const options = inboxQuery.parse(c.req.query())
        return c.json(await getEngine()!.groups.inbox(c.get('namespace'), actor(c.req.query('sessionId')), options, c.req.raw.signal))
    })
    app.post('/groups/consume', async c => {
        const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100) }).strict().parse(await c.req.json())
        getEngine()!.groups.consume(c.get('namespace'), actor(c.req.query('sessionId')), ids)
        return c.json({ ok: true })
    })
    app.get('/groups/:id', c => {
        const service = getEngine()!.groups
        const group = service.member(c.req.param('id'), c.get('namespace'), actor(c.req.query('sessionId')))
        return c.json({ group, members: service.members(group.id, c.get('namespace')) })
    })
    app.get('/groups/:id/history', c => {
        const service = getEngine()!.groups
        const id = c.req.param('id')
        service.member(id, c.get('namespace'), actor(c.req.query('sessionId')))
        const query = z.object({
            after: z.coerce.number().int().min(0).default(0),
            before: z.coerce.number().int().positive().default(Number.MAX_SAFE_INTEGER),
            limit: z.coerce.number().int().min(1).max(100).default(50)
        }).parse(c.req.query())
        const latest = c.req.query('after') === undefined
        const messages = service.store.groups.history(id, query.after, query.before, query.limit + 1, latest)
        return c.json({ messages: latest ? messages.slice(-query.limit) : messages.slice(0, query.limit), hasMore: messages.length > query.limit })
    })
    app.post('/groups/:id/send', async c => {
        const input = GroupSendSchema.parse(await c.req.json())
        return c.json(await getEngine()!.groups.send(c.req.param('id'), c.get('namespace'), actor(c.req.query('sessionId')), input))
    })
    app.post('/groups/:id/:action', async c => {
        const service = getEngine()!.groups
        const id = c.req.param('id')
        const namespace = c.get('namespace')
        const sender = actor(c.req.query('sessionId'))
        const memberId = service.actor(sender, namespace)
        const action = c.req.param('action')
        if (action === 'join') service.add(id, namespace, sender)
        else {
            const group = service.member(id, namespace, sender)
            service.writable(group)
            if (action === 'add') {
                const body = z.object({ sessionId: z.string().uuid() }).strict().parse(await c.req.json())
                service.add(id, namespace, { kind: 'session', sessionId: body.sessionId })
            } else if (action === 'leave') service.store.groups.leave(id, memberId)
            else if (action === 'archive') service.store.groups.archive(id)
            else if (action === 'settings') {
                const body = z.object({ mentionWake: z.boolean(), sessionId: z.string().uuid().optional() }).strict().parse(await c.req.json())
                const target = !cli && body.sessionId ? body.sessionId : memberId
                if (!service.store.groups.members(id).some(m => m.id === target)) throw new GroupError('Member not found', 404)
                service.store.groups.settings(id, target, body.mentionWake)
            } else throw new GroupError('Unknown action', 404)
            service.changed(c.get('namespace'))
        }
        return c.json({ ok: true, members: service.members(id, namespace) })
    })
    return app
}
