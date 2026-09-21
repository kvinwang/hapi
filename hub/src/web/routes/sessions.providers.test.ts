import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function fixture(options: { admin?: boolean; flavor?: string; busy?: boolean; local?: boolean; fail?: boolean } = {}) {
    const session = { id: 's1', active: true, namespace: 'tenant-a', thinking: options.busy,
        agentState: { controlledByUser: options.local }, metadata: { flavor: options.flavor ?? 'codex' } } as Session
    const credentials = [
        { id: 'a', namespace: 'tenant-a', agentType: 'codex', name: 'Provider A', config: { auth: { test_fixture: true }, config: 'model = "model-a"\nmodel_provider = "a"' } },
        { id: 'b', namespace: 'tenant-b', agentType: 'codex', name: 'Provider B', config: { config: 'model = "model-b"' } },
        { id: 'claude', namespace: 'tenant-a', agentType: 'claude', name: 'Claude', config: {} },
        { id: 'bad', namespace: 'tenant-a', agentType: 'codex', name: 'Invalid', config: { config: '[' } }
    ]
    const applied: unknown[] = []
    const engine = {
        listSessionProfiles: async () => [{ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'profile-model' }],
        resolveSessionAccess: () => ({ ok: true, sessionId: 's1', session }),
        applySessionProvider: async (_id: string, selection: unknown) => {
            if (options.fail) throw new Error('synthetic private details')
            applied.push(selection)
        }
    } as unknown as SyncEngine
    const store = { credentials: {
        getCredentialsByNamespace: (ns: string) => credentials.filter((c) => c.namespace === ns),
        getCredentialByNamespace: (id: string, ns: string) => credentials.find((c) => c.id === id && c.namespace === ns)
    } } as unknown as Store
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'tenant-a')
        c.set('permissions', options.admin === false ? ['sessions:write'] : ['admin'])
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine, store))
    const select = (credentialId: string | null) => app.request('/api/sessions/s1/provider', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: credentialId === null ? { source: 'default' } : { source: 'credential', credentialId }, model: 'model-a' })
    })
    return { app, select, applied, credentials }
}

describe('session providers', () => {
    it('returns sanitized namespace-scoped picker entries, excluding malformed and other-agent configurations', async () => {
        const { app } = fixture()
        const response = await app.request('/api/sessions/s1/providers')
        expect(await response.json()).toEqual({ providers: [{ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'profile-model' }, { provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A', model: 'model-a' }] })
    })
    it('resolves credential IDs server-side and sends the whole configuration to the agent', async () => {
        const { select, applied, credentials } = fixture()
        expect((await select('a')).status).toBe(200)
        expect(applied).toEqual([{ provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A', model: 'model-a', config: credentials[0].config }])
    })
    it('supports restoring machine defaults without credential material', async () => {
        const { select, applied } = fixture()
        expect((await select(null)).status).toBe(200)
        expect(applied).toEqual([{ provider: { source: 'default' }, name: 'Machine default', model: 'model-a' }])
    })
    it('passes a validated native profile reference to the agent without reading credentials', async () => {
        const { app, applied } = fixture()
        const response = await app.request('/api/sessions/s1/provider', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: { source: 'profile', profile: 'redpill' }, model: 'profile-model' }) })
        expect(response.status).toBe(200)
        expect(applied).toEqual([{ provider: { source: 'profile', profile: 'redpill' }, model: 'profile-model', name: 'redpill' }])
    })
    it('rejects profile traversal before contacting the agent', async () => {
        const { app, applied } = fixture()
        const response = await app.request('/api/sessions/s1/provider', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: { source: 'profile', profile: '../outside' }, model: 'profile-model' }) })
        expect(response.status).toBe(400)
        expect(applied).toEqual([])
    })
    it('rejects cross-namespace and missing credentials', async () => {
        const { select, applied } = fixture()
        expect((await select('b')).status).toBe(404)
        expect((await select('missing')).status).toBe(404)
        expect(applied).toEqual([])
    })
    it('requires admin and rejects local/busy/non-Codex sessions', async () => {
        for (const [options, status] of [[{ admin: false }, 403], [{ busy: true }, 409], [{ local: true }, 409], [{ flavor: 'claude' }, 400]] as const) {
            const { select, applied } = fixture(options)
            expect((await select('a')).status).toBe(status)
            expect(applied).toEqual([])
        }
        expect((await fixture().select('claude')).status).toBe(400)
    })
    it('does not expose agent failure details', async () => {
        const response = await fixture({ fail: true }).select('a')
        expect(response.status).toBe(409)
        expect(await response.text()).not.toContain('private details')
    })
})
