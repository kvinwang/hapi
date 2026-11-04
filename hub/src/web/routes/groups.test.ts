import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { Store, type Permission } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { SyncEngine } from '../../sync/syncEngine'
import { createGroupRoutes } from './groups'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })
function setup(cli: boolean) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const session = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default')
    const routes = createGroupRoutes(() => engine, cli)
    const app = new Hono<{ Variables: { namespace: string; permissions: Permission[] } }>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('permissions', ['admin'])
        await next()
    })
    app.route('/', routes)
    const call = (path: string, body?: unknown) => app.request(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { store, engine, session, call }
}

describe('group HTTP API', () => {
    it('accepts a mention without text but rejects empty broadcasts', async () => {
        const { call, session, store, engine } = setup(false)
        const group = store.groups.create('default', 'Attention', '', { kind: 'session', sessionId: session.id })
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
        const sent = await call(`/groups/${group.id}/send`, { mentions: [session.id], clientMessageId: randomUUID() })
        expect(sent.status).toBe(200)
        expect(await sent.json()).toMatchObject({ message: { text: '', mentions: [session.id] }, mentions: [{ wakeStatus: 'woken' }] })
        const empty = await call(`/groups/${group.id}/send`, { text: '  ', clientMessageId: randomUUID() })
        expect(empty.status).toBe(400)
    })

    it('automatically joins the creating session and exposes its own unread count to the web', async () => {
        const { call, session, store, engine } = setup(true)
        const created = await (await call(`/groups?sessionId=${session.id}`, { name: 'Created by agent' })).json() as { group: { id: string } }
        const id = created.group.id
        expect(store.groups.members(id).map(member => member.id).sort()).toEqual([session.id, 'user'].sort())
        store.groups.send(id, { kind: 'user' }, { text: 'For the agent', mentions: [], clientMessageId: randomUUID() })
        const app = new Hono<{ Variables: { namespace: string; permissions: Permission[] } }>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['admin']); await next() })
        app.route('/', createGroupRoutes(() => engine))
        const response = await app.request(`/groups?sessionId=${session.id}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ groups: [{ id, unread: 1 }] })
        expect(store.groups.unread(id, session.id)).toBe(1)
        store.groups.leave(id, session.id)
        expect(await (await app.request(`/groups?sessionId=${session.id}`)).json()).toEqual({ groups: [] })
    })

    it('requires a valid session identity for CLI operations', async () => {
        const { call } = setup(true)
        expect((await call('/groups')).status).toBe(400)
        expect((await call(`/groups?sessionId=${randomUUID()}`)).status).toBe(404)
        expect((await call('/groups?sessionId=bad')).status).toBe(400)
    })

    it('allows humans to create and send, but never accepts a claimed session sender', async () => {
        const { call, session } = setup(false)
        const created = await (await call('/groups', { name: 'Review' })).json() as { group: { id: string } }
        const id = created.group.id
        expect((await call(`/groups/${id}/add`, { sessionId: session.id })).status).toBe(200)
        const sent = await (await call(`/groups/${id}/send`, { text: 'Review this', mentions: [session.id], clientMessageId: randomUUID() })).json() as { message: { sender: { kind: string } }; mentions: Array<{ reason: string }> }
        expect(sent.message.sender.kind).toBe('user')
        expect(sent.mentions[0].reason).toBe('inactive')
        expect((await call(`/groups/${id}/send`, { text: 'Spoof', sender: { kind: 'session', sessionId: session.id }, clientMessageId: randomUUID() })).status).toBe(400)
    })

    it('reads without consuming until the CLI confirms successful output, and bounds waits', async () => {
        const { store, call, session } = setup(true)
        const actor = `sessionId=${session.id}`
        const group = store.groups.create('default', 'Test', '', { kind: 'session', sessionId: session.id })
        store.groups.send(group.id, { kind: 'user' }, { text: 'Hello', mentions: [], clientMessageId: randomUUID() })
        expect((await call(`/groups/inbox?${actor}&wait=61`)).status).toBe(400)
        const inbox = await (await call(`/groups/inbox?${actor}`)).json() as { messages: Array<{ id: string }> }
        expect(inbox.messages).toHaveLength(1)
        expect(store.groups.unread(group.id, session.id)).toBe(1)
        expect((await call(`/groups/consume?${actor}`, { ids: inbox.messages.map(m => m.id) })).status).toBe(200)
        expect(store.groups.unread(group.id, session.id)).toBe(0)
    })
})
