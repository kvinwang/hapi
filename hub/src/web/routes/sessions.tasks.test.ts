import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function setup() {
    const backgroundTask = mock(async () => ({ output: 'hello' }))
    const engine = {
        resolveSessionAccess: (id: string, namespace: string) => {
            if (id === 'foreign') return { ok: false, reason: 'access-denied' }
            if (id === 'missing') return { ok: false, reason: 'not-found' }
            return { ok: true, sessionId: id, session: { id, namespace, active: id !== 'inactive', metadata: { backgroundTasks: { bg1: { id: 'bg1' } } } } }
        },
        backgroundTask
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'alpha'); await next() })
    app.route('/api', createSessionsRoutes(() => engine, new Store(':memory:')))
    return { app, backgroundTask }
}

describe('background task routes', () => {
    it('forwards output and stop for known tasks only', async () => {
        const { app, backgroundTask } = setup()
        expect((await app.request('/api/sessions/session/tasks/bg1/output')).status).toBe(200)
        expect(backgroundTask).toHaveBeenLastCalledWith('session', 'bg1', 'output')
        expect((await app.request('/api/sessions/session/tasks/bg1/stop', { method: 'POST' })).status).toBe(200)
        expect(backgroundTask).toHaveBeenLastCalledWith('session', 'bg1', 'stop')
    })

    it('rejects inaccessible sessions, inactive agents, and unknown tasks before RPC', async () => {
        const { app, backgroundTask } = setup()
        for (const action of ['output', 'stop']) {
            const method = action === 'output' ? 'GET' : 'POST'
            for (const [id, status] of [['foreign', 403], ['missing', 404], ['inactive', 409]] as const) {
                expect((await app.request(`/api/sessions/${id}/tasks/bg1/${action}`, { method })).status).toBe(status)
            }
            expect((await app.request(`/api/sessions/session/tasks/unknown/${action}`, { method })).status).toBe(404)
        }
        expect(backgroundTask).not.toHaveBeenCalled()
    })
})
