import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function createUsageRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/usage', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor
        if (flavor !== 'claude' && flavor !== 'codex') {
            return c.json({
                success: false,
                error: 'Usage is not supported for this session agent'
            })
        }

        const machineId = sessionResult.session.metadata?.machineId
        if (!machineId) {
            return c.json({
                success: false,
                error: 'Machine ID is missing for this session'
            })
        }

        const namespace = c.get('namespace')
        const machine = engine.getMachineByNamespace(machineId, namespace)
        if (!machine) {
            return c.json({
                success: false,
                error: 'Machine not found'
            }, 404)
        }

        try {
            const result = await engine.getUsage(machineId, flavor)
            return c.json(result)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to fetch usage'
            const isRpcUnavailable = message.includes('not registered')
            return c.json(
                { success: false, error: isRpcUnavailable ? 'Runner is offline or restarting' : message },
                isRpcUnavailable ? 503 : 500
            )
        }
    })

    return app
}
