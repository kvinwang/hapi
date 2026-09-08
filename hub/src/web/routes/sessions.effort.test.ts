import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function makeApp(options: { live?: boolean; flavor?: string; machineNamespace?: string; modelMode?: string } = {}) {
    const capabilities = { supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], isDefault: true }
    const session = {
        id: 's1', active: true, namespace: 'default', modelMode: options.modelMode ?? 'model-a',
        effortMode: 'high',
        metadata: {
            flavor: options.flavor ?? 'codex', machineId: 'machine',
            agentModelCatalog: options.live ? [{ id: 'model-a', ...capabilities }] : undefined
        }
    } as Session
    const applied: unknown[] = []
    const engine = {
        resolveSessionAccess: () => ({ ok: true, sessionId: 's1', session }),
        getMachine: () => ({ namespace: options.machineNamespace ?? 'default', metadata: {
            codexModels: [{ value: 'model-a', displayName: 'A', ...capabilities }]
        } }),
        applySessionConfig: async (_id: string, config: unknown) => { applied.push(config) }
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
    app.route('/api', createSessionsRoutes(() => engine, {} as Store))
    const request = (effort: string) => app.request('/api/sessions/s1/effort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort })
    })
    return { request, applied, session }
}

describe('model-aware effort validation', () => {
    it.each([true, false])('accepts reported effort IDs from live=%s catalogs', async (live) => {
        const { request, applied } = makeApp({ live })
        expect((await request('ultra')).status).toBe(200)
        expect(applied).toEqual([{ effortMode: 'ultra' }])
    })

    it('rejects levels the selected model does not support', async () => {
        const { request, applied, session } = makeApp({ live: true })
        expect((await request('high')).status).toBe(400)
        expect(applied).toEqual([])
        expect(session.effortMode).toBe('high')
    })

    it('keeps Default selectable', async () => {
        const { request } = makeApp({ live: true })
        expect((await request('default')).status).toBe(200)
    })

    it('keeps other agents on their existing effort validation', async () => {
        const { request } = makeApp({ flavor: 'claude', live: true })
        expect((await request('ultra')).status).toBe(400)
        expect((await request('max')).status).toBe(200)
    })

    it('does not use a catalog from another namespace', async () => {
        const { request } = makeApp({ machineNamespace: 'other' })
        expect((await request('ultra')).status).toBe(400)
    })

    it('uses the catalog default when Auto has no resolved model yet', async () => {
        const { request } = makeApp({ modelMode: 'auto' })
        expect((await request('ultra')).status).toBe(200)
    })
})
