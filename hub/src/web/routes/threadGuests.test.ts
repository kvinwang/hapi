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

it('redeems a code once, and replaying it can neither renew nor evict the guest', async () => {
    const { app, grant, login } = setup()
    const { grant: created, code } = await grant({ expiresIn: '7d' })
    const first = await login(created.id, code)
    expect(first.status).toBe(200)
    const auth = await first.json() as ThreadGuestAuth
    expect(auth.expiresAt).toBe(created.expiresAt)
    for (let i = 0; i < 10; i++) expect((await login(created.id, code)).status).toBe(401)
    expect((await app.request('/api/thread-guest/thread', { headers: { Authorization: `Bearer ${auth.token}` } })).status).toBe(200)
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

    store.threads.send(thread.id, { kind: 'user', guest: true }, { text: 'Session guest', mentions: [], clientMessageId: randomUUID() })
    expect(store.threads.guestGrant(grant.id)!.wakeCount).toBe(1)
    store.threads.send(thread.id, { kind: 'user' }, { text: 'Owner', mentions: [], clientMessageId: randomUUID() })
    expect(store.threads.guestGrant(grant.id)!.wakeCount).toBe(0)

    const patched = await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messagesPerMinute: 3, maxTextLength: 100, wakeLimit: 2 }) })
    expect(await patched.json()).toMatchObject({ grant: { wakeLimit: 2, wakeCount: 0 } })
})

it('lets guests be mentioned without waking anything or spending a wake budget', async () => {
    const { store, engine, thread, guest, send } = setup()
    const alice = await guest({ wakeLimit: 1 })
    const bob = await guest({ name: 'Bob' })

    const sent = await (await send(alice.token, { text: 'Bob?', mentions: [bob.grant.guestId] })).json() as { message: { id: string; mentions: string[] }; wake: string }
    expect(sent).toMatchObject({ message: { mentions: [bob.grant.guestId] }, wake: 'none' })
    expect(store.threads.guestGrant(alice.grant.id)!.wakeCount).toBe(0)

    const { message, mentions } = await engine.threads.send(thread.id, 'default', { kind: 'user' }, { text: 'Alice?', mentions: [alice.grant.guestId], clientMessageId: randomUUID() })
    expect(mentions.map(receipt => receipt.memberId)).not.toContain(alice.grant.guestId)
    expect(message.receipts.find(receipt => receipt.memberId === alice.grant.guestId)).toMatchObject({ wakeStatus: null })
})

it('revokes access immediately and removes the guest from the thread', async () => {
    const { app, owner, store, thread, guest } = setup()
    const { token, grant } = await guest()
    expect((await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/thread-guest/thread', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(store.threads.members(thread.id).some(member => member.id === grant.guestId)).toBe(false)
})

it('pauses an expired guest, keeping its token and identity until the owner renews the grant', async () => {
    const { app, owner, store, engine, session, thread, guest } = setup()
    const { token, grant } = await guest()
    const view = () => app.request('/api/thread-guest/thread', { headers: { Authorization: `Bearer ${token}` } })
    const renew = (expiresIn: string) => owner.request(`/threads/${thread.id}/guests/${grant.id}/renew`, json({ expiresIn }))
    store.threads.renewGuestGrant(thread.id, grant.id, Date.now() - 1)

    expect((await view()).status).toBe(403)
    expect(engine.threads.context(session.id, 'default')).not.toContain('Alice')
    expect((await owner.request(`/threads/${thread.id}/guests/${grant.id}/code`, { method: 'POST' })).status).toBe(404)
    const listed = await (await owner.request(`/threads/${thread.id}/guests`)).json() as { grants: ThreadGuestGrant[] }
    expect(listed.grants.map(g => g.id)).toEqual([grant.id])

    expect((await renew('never')).status).toBe(400)
    const before = Date.now()
    const renewed = await (await renew('7d')).json() as { grant: ThreadGuestGrant }
    expect(renewed.grant.expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 3600_000)
    expect((await view()).status).toBe(200)
    expect(engine.threads.context(session.id, 'default')).toContain('external guests: Alice')

    await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'DELETE' })
    expect((await renew('1d')).status).toBe(404)
})

it('serves agent instructions against the configured public URL', async () => {
    const { app } = setup()
    const response = await app.request('/api/thread-guest/agent.md?grant=abc_123', { headers: { Host: 'evil.example' } })
    const text = await response.text()
    expect(text).toContain('https://hub.example/api/thread-guest/auth')
    expect(text).not.toContain('evil.example')
})

it('lets authors edit and recall their own messages, and the owner recall any', async () => {
    const { store, engine, session, thread, owner } = setup()
    const post = (path: string, body: unknown = {}) => owner.request(`/threads/${thread.id}/messages/${path}`, json(body))
    const agent = { kind: 'session', sessionId: session.id } as const
    const agentMessage = (await engine.threads.send(thread.id, 'default', agent, { text: 'From the agent', mentions: [], clientMessageId: randomUUID() })).message
    const ownerMessage = store.threads.history(thread.id, 0, Number.MAX_SAFE_INTEGER, 10)[0]

    expect(await (await post(`${ownerMessage.id}/edit`, { text: 'Corrected' })).json()).toMatchObject({ message: { text: 'Corrected', editedAt: expect.any(Number) } })
    expect(store.threads.message(ownerMessage.id)).toMatchObject({ text: 'Corrected' })
    expect((await post(`${agentMessage.id}/edit`, { text: 'Not yours' })).status).toBe(403)
    expect(() => engine.threads.edit(thread.id, 'default', agent, ownerMessage.id, 'Not yours either')).toThrow('Only the author')

    expect(store.threads.unread(thread.id, 'user')).toBe(1)
    expect(await (await post(`${agentMessage.id}/recall`)).json()).toMatchObject({ message: { text: '', mentions: [], recalledAt: expect.any(Number) } })
    expect(store.threads.unread(thread.id, 'user')).toBe(0)
    expect(engine.threads.store.threads.inbox('default', 'user', { limit: 10 }).messages).toEqual([])
    expect((await post(`${agentMessage.id}/edit`, { text: 'Too late' })).status).toBe(409)

    store.threads.archive(thread.id)
    expect((await post(`${ownerMessage.id}/recall`)).status).toBe(409)
})

it('keeps guest edit and recall off unless the grant allows it, and then only for its own messages', async () => {
    const { app, owner, thread, guest, send } = setup()
    const { token, grant } = await guest({ maxTextLength: 100 })
    const auth = { Authorization: `Bearer ${token}` }
    const { message } = await (await send(token, { text: 'Typo here' })).json() as { message: { id: string } }
    const act = (id: string, action: string, body: unknown = {}) => app.request(`/api/thread-guest/messages/${id}/${action}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    expect((await act(message.id, 'edit', { text: 'Fixed' })).status).toBe(403)
    expect((await act(message.id, 'recall')).status).toBe(403)

    await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messagesPerMinute: 10, maxTextLength: 100, wakeLimit: 20, allowEdit: true }) })
    expect((await act(message.id, 'edit', { text: 'x'.repeat(101) })).status).toBe(413)
    expect(await (await act(message.id, 'edit', { text: 'Fixed' })).json()).toMatchObject({ message: { text: 'Fixed', receipts: [] } })
    const ownerMessage = await (await owner.request(`/threads/${thread.id}/send`, json({ text: 'Owner note', clientMessageId: randomUUID() }))).json() as { message: { id: string } }
    expect((await act(ownerMessage.message.id, 'recall')).status).toBe(403)
    expect(await (await act(message.id, 'recall')).json()).toMatchObject({ message: { recalledAt: expect.any(Number) } })
})

it('lets the owner issue a new code that keeps the identity and signs out the previous client', async () => {
    const { app, owner, thread, guest, login, send } = setup()
    const { token, grant } = await guest()
    await send(token, { text: 'Before the new code' })
    const reissue = () => owner.request(`/threads/${thread.id}/guests/${grant.id}/code`, { method: 'POST' })
    const response = await reissue()
    const { code } = await response.json() as { code: string }
    expect((await app.request('/api/thread-guest/thread', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    const auth = await (await login(grant.id, code)).json() as ThreadGuestAuth
    expect(auth.guest.id).toBe(grant.guestId)
    const history = await (await app.request('/api/thread-guest/history', { headers: { Authorization: `Bearer ${auth.token}` } })).json() as ThreadInbox
    expect(history.messages.map(message => message.text)).toEqual(['Before the new code'])
    expect((await login(grant.id, code)).status).toBe(401)

    await owner.request(`/threads/${thread.id}/guests/${grant.id}`, { method: 'DELETE' })
    expect((await reissue()).status).toBe(404)
})
