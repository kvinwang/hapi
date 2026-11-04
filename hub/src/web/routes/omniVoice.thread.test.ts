import { afterEach, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SyncEngine } from '../../sync/syncEngine'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createOmniVoiceRoutes } from './omniVoice'
import { randomUUID } from 'node:crypto'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })
it('creates voice context for a thread without resolving it as an agent session', async () => {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const thread = store.threads.create('default', 'Review', 'API review', { kind: 'user' })
    store.threads.send(thread.id, { kind: 'user' }, { text: 'Check token expiry', mentions: [], clientMessageId: randomUUID() })
    store.preferences.set('default', 'dashscopeApiKey', 'test-only-placeholder')
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['admin']); await next() })
    app.route('/', createOmniVoiceRoutes(() => engine, store))
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ token: 'test-only-token', expires_at: 1 }), { status: 200 }))
    try {
        const call = (body: unknown) => app.request('/voice/omni/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const response = await call({ threadId: thread.id })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ title: 'Review', context: expect.stringContaining('User: Check token expiry') })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect((await call({ threadId: randomUUID() })).status).toBe(404)
        expect((await call({ threadId: thread.id, sessionId: randomUUID() })).status).toBe(400)
        store.threads.archive(thread.id)
        expect((await call({ threadId: thread.id })).status).toBe(409)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { fetchMock.mockRestore() }
})
