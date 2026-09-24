import { Hono } from 'hono'
import { z } from 'zod'
import {
    CredentialAgentSchema,
    CredentialConfigSchema,
    CredentialEndpointsSchema,
    credentialProtocolFor
} from '@hapi/protocol'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'
import { hasPermission } from '../../auth/permissions'
import { discoverModels } from '../../modelDiscovery'

const createCredentialSchema = z.object({
    name: z.string().min(1).max(200),
    config: CredentialConfigSchema
})

const updateCredentialSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    config: CredentialConfigSchema.optional()
})

const discoverModelsSchema = z.object({
    apiKey: z.string().min(1),
    endpoints: CredentialEndpointsSchema,
    headers: z.record(z.string(), z.string()).optional()
})

const applyCredentialSchema = z.object({
    credentialId: z.string().min(1),
    agent: CredentialAgentSchema
})

export function createCredentialsRoutes(
    store: Store,
    getSyncEngine: () => SyncEngine | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/credentials', (c) => {
        const namespace = c.get('namespace')
        const credentials = store.credentials.getCredentialsByNamespace(namespace)
        return c.json({ credentials })
    })

    app.post('/credentials', async (c) => {
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)
        const parsed = createCredentialSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        const credential = store.credentials.createCredential({
            id: crypto.randomUUID(),
            namespace,
            name: parsed.data.name,
            config: parsed.data.config
        })

        return c.json({ credential }, 201)
    })

    app.put('/credentials/:id', async (c) => {
        const namespace = c.get('namespace')
        const credentialId = c.req.param('id')
        const body = await c.req.json().catch(() => null)
        const parsed = updateCredentialSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        if (parsed.data.name === undefined && parsed.data.config === undefined) {
            return c.json({ error: 'Nothing to update' }, 400)
        }

        const credential = store.credentials.updateCredential(credentialId, namespace, {
            name: parsed.data.name,
            config: parsed.data.config
        })

        if (!credential) {
            return c.json({ error: 'Credential not found' }, 404)
        }

        return c.json({ credential })
    })

    app.delete('/credentials/:id', async (c) => {
        const namespace = c.get('namespace')
        const credentialId = c.req.param('id')
        const deleted = store.credentials.deleteCredential(credentialId, namespace)
        if (!deleted) {
            return c.json({ error: 'Credential not found' }, 404)
        }
        return c.json({ ok: true })
    })

    // Takes the draft endpoints/key so unsaved credentials can be populated too.
    app.post('/credentials/discover-models', async (c) => {
        if (!hasPermission(c.get('permissions') ?? [], 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const parsed = discoverModelsSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }
        try {
            return c.json({ models: await discoverModels(parsed.data) })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Unable to list models' }, 502)
        }
    })

    app.post('/machines/:id/apply-credentials', async (c) => {
        const permissions = c.get('permissions') ?? []
        if (!hasPermission(permissions, 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = applyCredentialSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        const credential = store.credentials.getCredentialByNamespace(parsed.data.credentialId, namespace)
        if (!credential) {
            return c.json({ error: 'Credential not found' }, 404)
        }
        if (!credentialProtocolFor(credential.config, parsed.data.agent)) {
            return c.json({ error: `Credential has no endpoint compatible with ${parsed.data.agent}` }, 400)
        }

        try {
            const result = await engine.applyCredentials(machineId, parsed.data.agent, credential.config)
            if (!result.success) {
                return c.json({ error: result.error ?? 'Failed to apply credentials' }, 500)
            }

            return c.json({
                success: true,
                written: result.written
            })
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to apply credentials'
            }, 500)
        }
    })

    app.get('/machines/:id/read-credentials', async (c) => {
        const permissions = c.get('permissions') ?? []
        if (!hasPermission(permissions, 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const agent = CredentialAgentSchema.safeParse(c.req.query('agent'))
        if (!agent.success) {
            return c.json({ error: 'Invalid agent query parameter' }, 400)
        }

        try {
            const result = await engine.readCredentials(machineId, agent.data)
            if (!result.success) return c.json(result)
            const config = CredentialConfigSchema.safeParse(result.config)
            if (!config.success) return c.json({ success: false, error: `No importable ${agent.data} API credential found` })
            return c.json({ success: true, config: config.data })
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read credentials'
            }, 500)
        }
    })

    return app
}
