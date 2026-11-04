import { afterEach, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { Store, type Permission } from '../../store'
import { SyncEngine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { createThreadRoutes } from './threads'
import { createThreadShareRoutes } from './threadShare'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })
function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const session = engine.createSession('share-worker', { name: 'Reviewer', path: '/private/workspace', host: 'private-machine' }, 'default')
    const thread = store.threads.create('default', 'Public discussion', 'Review progress', { kind: 'session', sessionId: session.id })
    const privateMessage = store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Private session transcript' } })
    const message = store.threads.send(thread.id, { kind: 'session', sessionId: session.id }, { text: 'Thread-only message', mentions: [], clientMessageId: randomUUID() }).message
    const owner = new Hono<{ Variables: { namespace: string; permissions: Permission[] } }>()
    owner.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['admin']); await next() })
    owner.route('/', createThreadRoutes(() => engine))
    const publicApp = createThreadShareRoutes(store)
    const sharing = (enabled: boolean) => owner.request(`/threads/${thread.id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
    return { store, engine, owner, publicApp, session, thread, message, privateMessage, sharing }
}
it('shares only the selected thread, without granting access to private sessions or read receipts', async () => {
    const { store, publicApp, session, thread, message, sharing } = setup()
    expect((await publicApp.request(`/share/threads/${thread.id}`)).status).toBe(404)
    const enabled = await sharing(true)
    const { shareToken } = await enabled.json() as { shareToken: string }
    expect(shareToken).not.toBe(thread.id)
    const metadata = await publicApp.request(`/share/threads/${shareToken}`)
    expect(metadata.status).toBe(200)
    expect(metadata.headers.get('cache-control')).toBe('no-store')
    const info = await metadata.json()
    expect(info).toMatchObject({ thread: { name: 'Public discussion' }, members: expect.arrayContaining([{ id: session.id, kind: 'session', name: 'Reviewer' }]) })
    expect(JSON.stringify(info)).not.toContain('/private/workspace')
    expect(JSON.stringify(info)).not.toContain('private-machine')
    expect(JSON.stringify(info)).not.toContain('wakeLimit')
    const history = await publicApp.request(`/share/threads/${shareToken}/messages`)
    expect(await history.json()).toMatchObject({ messages: [{ id: message.id, text: 'Thread-only message', receipts: [] }] })
    expect(store.threads.unread(thread.id, 'user')).toBe(1)
    expect((await publicApp.request(`/share/threads/${shareToken}/messages`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await publicApp.request(`/share/threads/${shareToken}/sessions/${session.id}`)).status).toBe(404)
    expect(store.threads.get(thread.id, 'default')).not.toHaveProperty('shareToken')
})
it('revokes old links permanently, including after re-enabling and archiving', async () => {
    const { sharing, publicApp, store, thread } = setup()
    const first = await (await sharing(true)).json() as { shareToken: string }
    expect(await (await sharing(true)).json()).toEqual(first)
    store.threads.archive(thread.id)
    expect((await publicApp.request(`/share/threads/${first.shareToken}`)).status).toBe(200)
    expect(await (await sharing(false)).json()).toEqual({ shareToken: null })
    expect((await publicApp.request(`/share/threads/${first.shareToken}`)).status).toBe(404)
    expect((await publicApp.request(`/share/threads/${first.shareToken}/messages`)).status).toBe(404)
    const second = await (await sharing(true)).json() as { shareToken: string }
    expect(second.shareToken).not.toBe(first.shareToken)
    store.threads.restore(thread.id)
    expect((await publicApp.request(`/share/threads/${first.shareToken}`)).status).toBe(404)
    expect((await publicApp.request(`/share/threads/${second.shareToken}`)).status).toBe(200)
})
it('bounds and validates pagination and never crosses threads', async () => {
    const { store, thread, sharing, publicApp } = setup()
    for (let i = 0; i < 3; i++) store.threads.send(thread.id, { kind: 'user' }, { text: `Message ${i}`, mentions: [], clientMessageId: randomUUID() })
    const other = store.threads.create('default', 'Other', '', { kind: 'user' })
    store.threads.send(other.id, { kind: 'user' }, { text: 'Must stay private', mentions: [], clientMessageId: randomUUID() })
    const { shareToken } = await (await sharing(true)).json() as { shareToken: string }
    const page = await (await publicApp.request(`/share/threads/${shareToken}/messages?limit=2`)).json() as { messages: Array<{ seq: number }>; hasMore: boolean }
    expect(page.messages.map(message => message.seq)).toEqual([3, 4])
    expect(page.hasMore).toBe(true)
    const older = await (await publicApp.request(`/share/threads/${shareToken}/messages?limit=2&before=3`)).json() as { messages: Array<{ seq: number }>; hasMore: boolean }
    expect(older.messages.map(message => message.seq)).toEqual([1, 2])
    expect(older.hasMore).toBe(false)
    expect((await publicApp.request(`/share/threads/${shareToken}/messages?limit=101`)).status).toBe(400)
})
