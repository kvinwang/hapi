import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

function fixture(options: { admin?: boolean; flavor?: string; busy?: boolean; local?: boolean; fail?: boolean; safeError?: string } = {}) {
    const session = { id: 's1', active: true, namespace: 'tenant-a', thinking: options.busy,
        agentState: { controlledByUser: options.local }, metadata: { flavor: options.flavor ?? 'codex' } } as Session
    const api = (id: string, endpoints: Record<string, string>, models: string[]) => ({
        provider: id, apiKey: 'synthetic-key', endpoints, models: models.map((model) => ({ id: model })), defaultModel: models[0]
    })
    const credentials = [
        { id: 'a', namespace: 'tenant-a', name: 'Provider A', config: api('a', { 'openai-responses': 'https://a.invalid/v1' }, ['model-a', 'model-a2']) },
        { id: 'b', namespace: 'tenant-b', name: 'Provider B', config: api('b', { 'openai-responses': 'https://b.invalid/v1' }, ['model-b']) },
        { id: 'claude', namespace: 'tenant-a', name: 'Claude', config: api('c', { 'anthropic-messages': 'https://c.invalid' }, ['model-c']) }
    ]
    const applied: unknown[] = []
    const engine = {
        listSessionProfiles: async () => [{ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'profile-model' }],
        resolveSessionAccess: () => ({ ok: true, sessionId: 's1', session }),
        applySessionProvider: async (_id: string, selection: unknown) => {
            if (options.safeError) throw new Error(options.safeError)
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
    it('returns one namespace-scoped entry per model, excluding incompatible credentials', async () => {
        const { app } = fixture()
        const response = await app.request('/api/sessions/s1/providers')
        expect(await response.json()).toEqual({ providers: [{ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'profile-model' }, { provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A', model: 'model-a' }, { provider: { source: 'credential', credentialId: 'a' }, name: 'Provider A', model: 'model-a2' }] })
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
    it('exposes only allowlisted actionable diagnostics', async () => {
        const message = 'This session does not support provider switching. Resume it with the updated HAPI CLI.'
        const response = await fixture({ safeError: message }).select('a')
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: message })
    })
    it('does not expose agent failure details', async () => {
        const response = await fixture({ fail: true }).select('a')
        expect(response.status).toBe(409)
        expect(await response.text()).not.toContain('private details')
    })
})
