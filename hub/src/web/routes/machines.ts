import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'
import { hasPermission } from '../../auth/permissions'

const spawnBodySchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'cursor', 'gemini', 'grok', 'opencode']).optional(),
    model: z.string().optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    parentSessionId: z.string().uuid().optional()
})

const pathsExistsSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const permissions = c.get('permissions') ?? []
        const manage = c.req.query('manage') === 'true'

        if (manage) {
            const wantAll = c.req.query('all') === 'true'
            if (wantAll && !hasPermission(permissions, 'machines:read:all')) {
                return c.json({ error: 'Insufficient permissions' }, 403)
            }
            const allMachines = wantAll
                ? engine.getMachines()
                : engine.getMachinesByNamespace(namespace)
            const machines = allMachines.map((m) => {
                let apiKeyName: string | null = null
                if (m.apiKeyId) {
                    const key = store.apiKeys.getApiKeyById(m.apiKeyId)
                    apiKeyName = key?.name ?? null
                }
                return {
                    id: m.id,
                    namespace: m.namespace,
                    active: m.active,
                    activeAt: m.activeAt,
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt,
                    metadata: m.metadata,
                    apiKeyId: m.apiKeyId,
                    apiKeyName,
                    notes: m.notes,
                }
            })
            return c.json({ machines })
        }

        const wantAll = c.req.query('all') === 'true'
        if (wantAll && !hasPermission(permissions, 'machines:read:all')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const machines = wantAll
            ? engine.getOnlineMachines()
            : engine.getOnlineMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.post('/machines/:id/unbind', (c) => {
        const permissions = c.get('permissions') ?? []
        if (!hasPermission(permissions, 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const machine = engine.getMachineByNamespace(machineId, namespace)
        if (!machine) {
            if (engine.getMachine(machineId)) {
                return c.json({ error: 'Machine access denied' }, 403)
            }
            return c.json({ error: 'Machine not found' }, 404)
        }

        store.machines.unbindMachine(machineId)
        engine.refreshMachine(machineId)
        return c.json({ ok: true })
    })

    app.delete('/machines/:id', (c) => {
        const permissions = c.get('permissions') ?? []
        if (!hasPermission(permissions, 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const machine = engine.getMachineByNamespace(machineId, namespace)
        if (!machine) {
            if (engine.getMachine(machineId)) {
                return c.json({ error: 'Machine access denied' }, 403)
            }
            return c.json({ error: 'Machine not found' }, 404)
        }

        try {
            engine.deleteMachine(machineId)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to delete machine'
            return c.json({ error: message }, 409)
        }
    })

    app.patch('/machines/:id/notes', async (c) => {
        const permissions = c.get('permissions') ?? []
        if (!hasPermission(permissions, 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const machine = engine.getMachineByNamespace(machineId, namespace)
        if (!machine) {
            if (engine.getMachine(machineId)) {
                return c.json({ error: 'Machine access denied' }, 403)
            }
            return c.json({ error: 'Machine not found' }, 404)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = z.object({ notes: z.string().nullable() }).safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const updated = engine.updateMachineNotes(machineId, parsed.data.notes)
        if (!updated) {
            return c.json({ error: 'Failed to update notes' }, 500)
        }
        return c.json({ ok: true, notes: updated.notes })
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = spawnBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        if (parsed.data.parentSessionId) {
            const parent = engine.resolveSessionAccess(parsed.data.parentSessionId, c.get('namespace'))
            if (!parent.ok) {
                const status = parent.reason === 'access-denied' ? 403 : 404
                return c.json({ error: parent.reason === 'access-denied' ? 'Parent session access denied' : 'Parent session not found' }, status)
            }
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined,
            parsed.data.parentSessionId
        )
        return c.json(result)
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = pathsExistsSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            const exists = await engine.checkPathsExist(machineId, uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    return app
}
