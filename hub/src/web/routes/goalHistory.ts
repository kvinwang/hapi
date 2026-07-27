import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const listQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(50).optional()
})

const deleteSchema = z.object({
    objective: z.string().trim().min(1)
})

export function createGoalHistoryRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/goal-history', (c) => {
        const parsed = listQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
        return c.json({ goals: store.goalHistory.list(c.get('namespace'), parsed.data.limit ?? 20) })
    })

    app.delete('/goal-history', async (c) => {
        const parsed = deleteSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json({ deleted: store.goalHistory.delete(c.get('namespace'), parsed.data.objective) })
    })

    return app
}
