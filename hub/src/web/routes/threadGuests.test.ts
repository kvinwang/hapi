import { afterEach, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { ThreadGuestAuth, ThreadGuestGrant, ThreadGuestView, ThreadInbox } from '@hapi/protocol/threads'

mock.module('../../configuration', () => ({ configuration: { publicUrl: 'https://hub.example/' } }))

const { AuthService } = await import('../../auth/authService')
const { RevocationCache } = await import('../../auth/revocationCache')
const { Store } = await import('../../store')
const { SyncEngine } = await import('../../sync/syncEngine')
const { RpcRegistry } = await import('../../socket/rpcRegistry')
const { SSEManager } = await import('../../sse/sseManager')
const { VisibilityTracker } = await import('../../visibility/visibilityTracker')
const { createAuthMiddleware } = await import('../middleware/auth')
const { createThreadRoutes } = await import('./threads')
const { createThreadGuestGrantRoutes, createThreadGuestRoutes } = await import('./threadGuests')

const engines: InstanceType<typeof SyncEngine>[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })

const json = (body: unknown, token?: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
})

function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const authService = new AuthService(store, new RevocationCache(store.accessTokens, store.apiKeys), new TextEncoder().encode('test-secret-test-secret-test-secret'), 'legacy-token')
    const session = engine.createSession('guest-worker', { name: 'Reviewer', path: '/private/workspace', host: 'private-machine' }, 'default')
    const thread = store.threads.create('default', 'Design review', 'Discuss the API', { kind: 'session', sessionId: session.id })
    store.threads.send(thread.id, { kind: 'user' }, { text: 'Before the guest arrived', mentions: [], clientMessageId: randomUUID() })

    const app = new Hono()
    app.route('/api', createThreadGuestRoutes(() => engine, authService))
    app.use('/api/*', createAuthMiddleware(authService))
    const owner = new Hono<{ Variables: { namespace: string; permissions: ['admin'] } }>()
    owner.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['admin']); await next() })
    owner.route('/', createThreadGuestGrantRoutes(() => engine))
    owner.route('/', createThreadRoutes(() => engine))

    const grant = async (body: Record<string, unknown> = {}) => {
        const response = await owner.request(`/threads/${thread.id}/guests`, json({ name: 'Alice', ...body }))
        expect(response.status).toBe(201)
        return await response.json() as { grant: ThreadGuestGrant; code: string }
    }
    const login = async (grantId: string, code: string) => app.request('/api/thread-guest/auth', json({ grantId, code }))
    const guest = async (body: Record<string, unknown> = {}) => {
        const created = await grant(body)
        const auth = await (await login(created.grant.id, created.code)).json() as ThreadGuestAuth
        return { ...created, token: auth.token }
    }
    const send = (token: string, body: Record<string, unknown>) =>
        app.request('/api/thread-guest/send', json({ clientMessageId: randomUUID(), ...body }, token))
    return { store, engine, app, owner, session, thread, grant, login, guest, send }
}

it('confines a guest token to its own thread and hides private member details', async () => {
    const { app, engine, session, thread, guest } = setup()
    const { token, grant } = await guest()
    const auth = { headers: { Authorization: `Bearer ${token}` } }

    expect((await app.request('/api/sessions', auth)).status).toBe(401)
    expect((await app.request(`/api/threads/${thread.id}`, auth)).status).toBe(401)

    const view = await (await app.request('/api/thread-guest/thread', auth)).json() as ThreadGuestView
    expect(view.members).toEqual(expect.arrayContaining([
        { id: session.id, kind: 'session', name: 'Reviewer' },
        { id: grant.guestId, kind: 'guest', name: 'Alice' }
    ]))
    expect(JSON.stringify(view)).not.toMatch(/private-workspace|private-machine|\/private/)

    const history = await (await app.request('/api/thread-guest/history', auth)).json() as ThreadInbox
    expect(history.messages).toEqual([])
    expect(engine.threads.context(session.id, 'default')).toContain('external guests: Alice')
})

it('shows earlier history only when the grant includes it, never with receipts', async () => {
    const { app, guest } = setup()
    const { token } = await guest({ includeHistory: true })
    const history = await (await app.request('/api/thread-guest/history', { headers: { Authorization: `Bearer ${token}` } })).json() as ThreadInbox
    expect(history.messages).toMatchObject([{ text: 'Before the guest arrived', receipts: [] }])
    expect(history.messages[0]).not.toHaveProperty('clientMessageId')
    expect(history.messages[0]).not.toHaveProperty('senderId')
})

it('locks out a grant after repeated wrong codes', async () => {
    const { grant, login } = setup()
    const { grant: created, code } = await grant()
    for (let i = 0; i < 5; i++) expect((await login(created.id, 'WRONGCODE')).status).toBe(401)
    expect((await login(created.id, code)).status).toBe(401)
})

it('applies the per-grant length, rate, and wake limits', async () => {
    const { store, session, thread, guest, send, owner } = setup()
    const { token, grant } = await guest({ messagesPerMinute: 3, maxTextLength: 100, wakeLimit: 1 })

    expect((await send(token, { text: 'x'.repeat(101) })).status).toBe(413)
    const plain = await (await send(token, { text: 'No mention, no wake' })).json() as { message: { mentions: string[] }; wake: string }
    expect(plain).toMatchObject({ message: { mentions: [] }, wake: 'none' })
    expect(await (await send(token, { text: 'Please look', mentions: [session.id] })).json()).toMatchObject({ wake: 'requested' })
    expect(await (await send(token, { text: 'Again', mentions: [session.id] })).json()).toMatchObject({ wake: 'budget' })
    expect((await send(token, { text: 'Too fast' })).status).toBe(429)
    expect(store.threads.get(thread.id, 'default')!.wakeCount).toBe(0)

    store.threads.send(thread.id, { kind: 'user', guest: true }, { text: 'Session guest', mentions: [], clientMessageId: randomUUID() })
    expect(store.threads.guestGrant(grant.id)!.wakeCount).toBe(1)
    store.threads.send(thread.id, { kind: 'user' }, { text: 'Owner', mentions: [], clientMessageId: randomUUID() })
    expect(store.threads.guestGrant(grant.id)!.wakeCount).toBe(0)

    const patched = await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messagesPerMinute: 3, maxTextLength: 100, wakeLimit: 2 }) })
    expect(await patched.json()).toMatchObject({ grant: { wakeLimit: 2, wakeCount: 0 } })
})

it('revokes access immediately and removes the guest from the thread', async () => {
    const { app, owner, store, thread, guest } = setup()
    const { token, grant } = await guest()
    expect((await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/thread-guest/thread', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(store.threads.members(thread.id).some(member => member.id === grant.guestId)).toBe(false)
})

it('serves agent instructions against the configured public URL', async () => {
    const { app } = setup()
    const response = await app.request('/api/thread-guest/agent.md?grant=abc_123', { headers: { Host: 'evil.example' } })
    const text = await response.text()
    expect(text).toContain('https://hub.example/api/thread-guest/auth')
    expect(text).not.toContain('evil.example')
})
