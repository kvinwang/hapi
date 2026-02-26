import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'

const createCredentialSchema = z.object({
    name: z.string().min(1).max(200),
    agentType: z.enum(['claude', 'codex']),
    config: z.record(z.string(), z.unknown())
})

const updateCredentialSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    config: z.record(z.string(), z.unknown()).optional()
})

const applyCredentialSchema = z.object({
    credentialId: z.string().min(1),
    agentType: z.enum(['claude', 'codex'])
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

        const id = crypto.randomUUID()
        const credential = store.credentials.createCredential({
            id,
            namespace,
            name: parsed.data.name,
            agentType: parsed.data.agentType,
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

    app.post('/machines/:id/apply-credentials', async (c) => {
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

        if (credential.agentType !== parsed.data.agentType) {
            return c.json({ error: 'Credential agent type mismatch' }, 400)
        }

        try {
            const result = await engine.applyCredentials(machineId, parsed.data.agentType, credential.config)
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
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const agentType = c.req.query('agentType')
        if (agentType !== 'claude' && agentType !== 'codex') {
            return c.json({ error: 'Invalid agentType query parameter' }, 400)
        }

        try {
            const result = await engine.readCredentials(machineId, agentType)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read credentials'
            }, 500)
        }
    })

    return app
}
