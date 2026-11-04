import { expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SSEManager } from '../../sse/sseManager'
import { SyncEngine } from '../../sync/syncEngine'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'

it('authorizes every additional session and delivers favorite messages through the same stream', async () => {
    const store = new Store(':memory:')
    const visibility = new VisibilityTracker()
    const manager = new SSEManager(0, visibility)
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), manager)
    const current = engine.createSession('current', { path: '/tmp', host: 'test' }, 'alpha')
    const favorite = engine.createSession('favorite', { path: '/tmp', host: 'test' }, 'alpha')
    const foreign = engine.createSession('foreign', { path: '/tmp', host: 'test' }, 'beta')
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'alpha'); await next() })
    app.route('/', createEventsRoutes(() => manager, () => engine, () => visibility))
    const abort = new AbortController()
    try {
        expect((await app.request('/events?sessionIds=' + foreign.id)).status).toBe(403)
        expect((await app.request('/events?sessionIds=missing')).status).toBe(404)
        expect((await app.request('/events?' + Array(101).fill('sessionIds=missing').join('&'))).status).toBe(400)
        const response = await app.request('/events?sessionId=' + current.id + '&sessionIds=' + favorite.id, { signal: abort.signal })
        const reader = response.body!.getReader()
        await reader.read()
        manager.broadcast({ type: 'session-updated', namespace: 'alpha', sessionId: favorite.id })
        const chunk = new TextDecoder().decode((await reader.read()).value)
        expect(chunk).toContain(favorite.id)
        expect(chunk).not.toContain(foreign.id)
    } finally {
        abort.abort()
        manager.stop()
        engine.stop()
    }
}, 5000)
