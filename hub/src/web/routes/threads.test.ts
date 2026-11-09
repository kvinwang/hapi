import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { Store, type Permission } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { SyncEngine } from '../../sync/syncEngine'
import { createThreadRoutes } from './threads'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })
function setup(cli: boolean) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const session = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default')
    const routes = createThreadRoutes(() => engine, cli)
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

describe('thread HTTP API', () => {
    it('restores an archived thread without losing state or replaying canceled notifications', async () => {
        const { call, session, store, engine } = setup(false)
        const thread = store.threads.create('default', 'Restore me', '', { kind: 'session', sessionId: session.id })
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
        await engine.threads.send(thread.id, 'default', { kind: 'user' }, { text: 'Pending work', mentions: [], clientMessageId: randomUUID() })
        expect((await call(`/threads/${thread.id}/archive`, {})).status).toBe(200)
        const members = store.threads.members(thread.id)
        expect((await call(`/threads/${thread.id}/send`, { text: 'Blocked', clientMessageId: randomUUID() })).status).toBe(409)
        expect((await call(`/threads/${thread.id}/restore`, {})).status).toBe(200)
        expect((await call(`/threads/${thread.id}/restore`, {})).status).toBe(200)
        expect(store.threads.get(thread.id, 'default')).toMatchObject({ archived: false })
        expect(store.threads.members(thread.id)).toEqual(members)
        expect(store.threads.unread(thread.id, session.id)).toBe(1)
        engine.forceSessionIdle(session.id)
        await engine.threads.flush()
        expect(store.messages.getMessages(session.id, 10)).toHaveLength(0)
        expect(store.threads.pending()).toEqual([])
        expect((await call(`/threads/${thread.id}/send`, { text: 'New work', clientMessageId: randomUUID() })).status).toBe(200)
        expect(store.messages.getMessages(session.id, 10)).toHaveLength(1)
    })

    it('accepts a mention without text but rejects empty broadcasts', async () => {
        const { call, session, store, engine } = setup(false)
        const thread = store.threads.create('default', 'Attention', '', { kind: 'session', sessionId: session.id })
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: false })
        const sent = await call(`/threads/${thread.id}/send`, { mentions: [session.id], clientMessageId: randomUUID() })
        expect(sent.status).toBe(200)
        expect(await sent.json()).toMatchObject({ message: { text: '', mentions: [session.id] }, mentions: [{ wakeStatus: 'woken' }] })
        const empty = await call(`/threads/${thread.id}/send`, { text: '  ', clientMessageId: randomUUID() })
        expect(empty.status).toBe(400)
    })

    it('automatically joins the creating session and exposes its own unread count to the web', async () => {
        const { call, session, store, engine } = setup(true)
        const created = await (await call(`/threads?sessionId=${session.id}`, { name: 'Created by agent' })).json() as { thread: { id: string } }
        const id = created.thread.id
        expect(store.threads.members(id).map(member => member.id).sort()).toEqual([session.id, 'user'].sort())
        store.threads.send(id, { kind: 'user' }, { text: 'For the agent', mentions: [], clientMessageId: randomUUID() })
        const app = new Hono<{ Variables: { namespace: string; permissions: Permission[] } }>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['admin']); await next() })
        app.route('/', createThreadRoutes(() => engine))
        const response = await app.request(`/threads?sessionId=${session.id}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ threads: [{ id, unread: 1 }] })
        expect(store.threads.unread(id, session.id)).toBe(1)
        store.threads.leave(id, session.id)
        expect(await (await app.request(`/threads?sessionId=${session.id}`)).json()).toEqual({ threads: [] })
    })

    it('requires a valid session identity for CLI operations', async () => {
        const { call } = setup(true)
        expect((await call('/threads')).status).toBe(400)
        expect((await call(`/threads?sessionId=${randomUUID()}`)).status).toBe(404)
        expect((await call('/threads?sessionId=bad')).status).toBe(400)
    })

    it('allows humans to create and send, but never accepts a claimed session sender', async () => {
        const { call, session } = setup(false)
        const created = await (await call('/threads', { name: 'Review' })).json() as { thread: { id: string } }
        const id = created.thread.id
        expect((await call(`/threads/${id}/add`, { sessionId: session.id })).status).toBe(200)
        const sent = await (await call(`/threads/${id}/send`, { text: 'Review this', mentions: [session.id], clientMessageId: randomUUID() })).json() as { message: { sender: { kind: string } }; mentions: Array<{ reason: string }> }
        expect(sent.message.sender.kind).toBe('user')
        expect(sent.mentions[0].reason).toBe('inactive')
        expect((await call(`/threads/${id}/send`, { text: 'Spoof', sender: { kind: 'session', sessionId: session.id }, clientMessageId: randomUUID() })).status).toBe(400)
    })

    it('reads without consuming until the CLI confirms successful output, and bounds waits', async () => {
        const { store, call, session } = setup(true)
        const actor = `sessionId=${session.id}`
        const thread = store.threads.create('default', 'Test', '', { kind: 'session', sessionId: session.id })
        store.threads.send(thread.id, { kind: 'user' }, { text: 'Hello', mentions: [], clientMessageId: randomUUID() })
        expect((await call(`/threads/inbox?${actor}&wait=61`)).status).toBe(400)
        const inbox = await (await call(`/threads/inbox?${actor}`)).json() as { messages: Array<{ id: string }> }
        expect(inbox.messages).toHaveLength(1)
        expect(store.threads.unread(thread.id, session.id)).toBe(1)
        expect((await call(`/threads/consume?${actor}`, { ids: inbox.messages.map(m => m.id) })).status).toBe(200)
        expect(store.threads.unread(thread.id, session.id)).toBe(0)
    })
})

describe('thread tags', () => {
    it('normalizes, persists, lists, edits archived tags, and clears tags', async () => {
        const { call, store } = setup(false)
        const created = await (await call('/threads', { name: 'Tagged', tags: [' release ', 'release'] })).json() as { thread: { id: string; tags: string[] } }
        const { id } = created.thread
        expect(created.thread.tags).toEqual(['release'])
        expect((await call(`/threads/${id}/tags`, { tags: [' urgent ', 'backend', 'backend'] })).status).toBe(200)
        expect(await (await call('/threads')).json()).toMatchObject({ threads: [{ tags: ['urgent', 'backend'] }] })
        expect(await (await call(`/threads/${id}`)).json()).toMatchObject({ thread: { tags: ['urgent', 'backend'] } })
        await call(`/threads/${id}/archive`, {})
        expect((await call(`/threads/${id}/tags`, { tags: [] })).status).toBe(200)
        expect(store.threads.get(id, 'default')).toMatchObject({ archived: true, tags: [] })
    })

    it('rejects invalid tag payloads without changing existing labels', async () => {
        const { call, store } = setup(false)
        const thread = store.threads.create('default', 'Tagged', '', { kind: 'user' }, ['keep'])
        for (const tags of [[' '], ['a'.repeat(256)], Array.from({ length: 21 }, (_, i) => String(i)), [7], 'tag']) {
            expect((await call(`/threads/${thread.id}/tags`, { tags })).status).toBe(400)
        }
        expect(store.threads.get(thread.id, 'default')?.tags).toEqual(['keep'])
    })

    it('requires namespace access, membership, and write permissions', async () => {
        const { call, store, engine, session } = setup(true)
        const thread = store.threads.create('default', 'Private', '', { kind: 'user' })
        const other = store.threads.create('other', 'Other namespace', '', { kind: 'user' })
        expect((await call(`/threads/${thread.id}/tags?sessionId=${session.id}`, { tags: ['x'] })).status).toBe(403)
        expect((await call(`/threads/${other.id}/tags?sessionId=${session.id}`, { tags: ['x'] })).status).toBe(404)
        const app = new Hono<{ Variables: { namespace: string; permissions: Permission[] } }>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['sessions:read']); await next() })
        app.route('/', createThreadRoutes(() => engine))
        expect((await app.request(`/threads/${thread.id}/tags`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags: ['x'] })
        })).status).toBe(403)
        expect(store.threads.get(thread.id, 'default')?.tags).toEqual([])
    })
})
