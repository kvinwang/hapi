import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import { Store } from '../../store'
import { AuthService } from '../../auth/authService'
import { RevocationCache } from '../../auth/revocationCache'
import { hashApiKey } from '../../utils/apiKey'
import { SyncEngine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { createAuthMiddleware, type WebAppEnv } from './auth'
import { createThreadRoutes } from '../routes/threads'
import { createGuestGrantRoutes } from '../routes/guestGrants'

const engines: SyncEngine[] = []
afterEach(() => {
    engines.splice(0).forEach(engine => engine.stop())
})
async function setup() {
    const store = new Store(':memory:')
    const auth = new AuthService(
        store,
        new RevocationCache(store.accessTokens, store.apiKeys),
        new TextEncoder().encode('guest-scope-test-secret'),
        'owner-test-token'
    )
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const root = engine.createSession(randomUUID(), { path: '/root-private', host: 'host' }, 'default')
    const child = engine.createSession(
        randomUUID(),
        { path: '/child-private', host: 'host', subagent: { ownerSessionId: root.id, toolUseId: 'child' } },
        'default'
    )
    const nested = engine.createSession(
        randomUUID(),
        { path: '/nested', host: 'host', subagent: { ownerSessionId: child.id, toolUseId: 'nested' } },
        'default'
    )
    const other = engine.createSession(
        randomUUID(),
        { name: 'Another member', path: '/unrelated-private', host: 'private-host' },
        'default'
    )
    const otherChild = engine.createSession(
        randomUUID(),
        { path: '/other-child', host: 'host', subagent: { ownerSessionId: other.id, toolUseId: 'other' } },
        'default'
    )
    const thread = store.threads.create('default', 'Allowed', '', { kind: 'session', sessionId: root.id })
    engine.threads.add(thread.id, 'default', { kind: 'session', sessionId: other.id })
    const unselected = store.threads.create('default', 'Not selected', '', { kind: 'session', sessionId: root.id })
    const privateThread = store.threads.create('default', 'Unrelated', '', { kind: 'session', sessionId: other.id })
    const grant = store.sessionGrants.create({
        id: randomUUID(),
        sessionId: root.id,
        namespace: 'default',
        codeHash: hashApiKey('TEST2345'),
        description: null,
        allowVoice: false,
        expiresAt: Date.now() + 3600000
    })
    const token = await auth.createGuestJwt(grant.id)
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(auth))
    app.route(
        '/api',
        createThreadRoutes(() => engine)
    )
    app.route(
        '/api',
        createGuestGrantRoutes(() => engine, store)
    )
    let eventValidator: ((id: string | null) => Promise<boolean>) | undefined
    app.get('/api/events', c => {
        eventValidator = c.get('guestEventAllowed')
        return c.json({ ok: true })
    })
    app.all('/api/*', async c =>
        c.json({
            ok: true,
            streamAllowed: c.get('guestEventAllowed')
                ? await c.get('guestEventAllowed')!(c.req.query('sessionId') ?? null)
                : null
        })
    )
    const call = (path: string, method = 'GET', body?: unknown, access = token) =>
        app.request(`/api${path}`, {
            method,
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        })
    return {
        store,
        auth,
        engine,
        root,
        child,
        nested,
        other,
        otherChild,
        thread,
        unselected,
        privateThread,
        grant,
        call,
        eventValidator: () => eventValidator
    }
}

describe('guest agents and thread scopes', () => {
    it('rechecks a connected event stream against live agent scope and revocation', async () => {
        const { store, root, child, grant, call, eventValidator } = await setup()
        store.sessionGrants.setScope(grant.id, root.id, 'default', { allowAgents: true })
        expect((await call(`/events?sessionId=${child.id}`)).status).toBe(200)
        const validate = eventValidator()!
        expect(await validate(child.id)).toBe(true)
        store.sessionGrants.setScope(grant.id, root.id, 'default', { allowAgents: false })
        expect(await validate(child.id)).toBe(false)
        expect(await validate(root.id)).toBe(true)
        store.sessionGrants.revoke(grant.id, root.id, 'default')
        expect(await validate(root.id)).toBe(false)
    })

    it('keeps existing codes restricted and enables only descendants when opted in', async () => {
        const { store, root, child, nested, other, otherChild, grant, call } = await setup()
        expect((await call(`/sessions/${root.id}`)).status).toBe(200)
        expect((await call(`/sessions/${child.id}`)).status).toBe(403)
        store.sessionGrants.setScope(grant.id, root.id, 'default', { allowAgents: true })
        for (const id of [child.id, nested.id]) {
            expect((await call(`/sessions/${id}`)).status).toBe(200)
            expect((await call(`/sessions/${id}/messages`)).status).toBe(200)
            expect((await call(`/events?sessionId=${id}`)).status).toBe(200)
            for (const action of ['messages', 'abort', 'interrupt', 'resume'])
                expect((await call(`/sessions/${id}/${action}`, 'POST', {})).status).toBe(403)
            expect((await call(`/sessions/${id}/files`)).status).toBe(403)
        }
        for (const id of [other.id, otherChild.id]) expect((await call(`/sessions/${id}`)).status).toBe(403)
        expect((await call('/sessions')).status).toBe(403)
        expect((await call(`/events?sessionId=${root.id}&all=true`)).status).toBe(403)
        expect((await call(`/events?sessionId=${root.id}&sessionIds=${other.id}`)).status).toBe(403)
        store.sessionGrants.setScope(grant.id, root.id, 'default', { allowAgents: false })
        expect((await call(`/sessions/${child.id}/messages`)).status).toBe(403)
    })

    it('allows selected thread conversations but no management, private sessions, or owner read-state mutations', async () => {
        const { store, root, other, thread, unselected, privateThread, grant, call } = await setup()
        expect(await (await call('/threads')).json()).toEqual({ threads: [] })
        expect((await call(`/threads/${thread.id}`)).status).toBe(403)
        store.sessionGrants.setScope(grant.id, root.id, 'default', { threadIds: [thread.id] })
        const list = (await (await call(`/threads?sessionId=${root.id}`)).json()) as { threads: Array<{ id: string }> }
        expect(list.threads.map(item => item.id)).toEqual([thread.id])
        expect((await call(`/threads?sessionId=${other.id}`)).status).toBe(403)
        for (const id of [unselected.id, privateThread.id])
            expect((await call(`/threads/${id}/history`)).status).toBe(403)
        const sent = await call(`/threads/${thread.id}/send`, 'POST', {
            text: 'Guest message',
            mentions: [other.id],
            clientMessageId: randomUUID()
        })
        expect(sent.status).toBe(200)
        expect(store.threads.unread(thread.id, 'user')).toBe(1)
        expect(await sent.json()).toMatchObject({ message: { sender: { kind: 'user', guest: true } } })
        expect((await call(`/sessions/${other.id}`)).status).toBe(403)
        const details = JSON.stringify(await (await call(`/threads/${thread.id}`)).json())
        expect(details).not.toContain('/unrelated-private')
        expect(details).not.toContain('private-host')
        expect(
            (
                (await (await call(`/threads/${thread.id}/history`)).json()) as {
                    messages: Array<{ receipts: unknown[] }>
                }
            ).messages[0].receipts
        ).toEqual([])
        for (const action of ['add', 'join', 'leave', 'settings', 'archive', 'restore', 'share', 'tags'])
            expect((await call(`/threads/${thread.id}/${action}`, 'POST', {})).status).toBe(403)
        expect((await call('/threads/consume', 'POST', { ids: [] })).status).toBe(403)
        expect((await call('/threads', 'POST', { name: 'Forbidden' })).status).toBe(403)
        store.threads.leave(thread.id, root.id)
        expect((await call(`/threads/${thread.id}/history`)).status).toBe(403)
        expect(await (await call('/threads')).json()).toEqual({ threads: [] })
    })

    it('does not let an owner cookie override an explicit guest token', async () => {
        const { grant, auth, privateThread } = await setup()
        const token = await auth.createGuestJwt(grant.id)
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(auth))
        app.get('/api/threads/:id/history', c => c.json({ ok: true }))
        const response = await app.request(`/api/threads/${privateThread.id}/history`, {
            headers: { Authorization: `Bearer ${token}`, Cookie: 'hapi_token=owner-test-token' }
        })
        expect(response.status).toBe(403)
    })

    it('validates owner-selected threads and applies updates/revocation to the same guest token', async () => {
        const { root, privateThread, thread, grant, call } = await setup()
        const path = `/sessions/${root.id}/guest-grants/${grant.id}`
        expect((await call(path, 'PATCH', { threadIds: [privateThread.id] }, 'owner-test-token')).status).toBe(400)
        expect(
            (await call(path, 'PATCH', { threadIds: [thread.id], allowAgents: true }, 'owner-test-token')).status
        ).toBe(200)
        expect((await call(`/threads/${thread.id}/history`)).status).toBe(200)
        expect((await call(path, 'PATCH', { threadIds: [] }, 'owner-test-token')).status).toBe(200)
        expect((await call(`/threads/${thread.id}/history`)).status).toBe(403)
        expect((await call(path, 'PATCH', { allowAgents: true })).status).toBe(403)
        expect((await call(path, 'DELETE', undefined, 'owner-test-token')).status).toBe(200)
        expect((await call(`/sessions/${root.id}`)).status).toBe(401)
    })
})
