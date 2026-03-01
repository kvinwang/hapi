import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const updatePreferencesSchema = z.object({
    systemPrompt: z.string().max(10000).optional()
})

export function createPreferencesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/preferences', (c) => {
        const namespace = c.get('namespace')
        const systemPrompt = store.preferences.get(namespace, 'systemPrompt')
        return c.json({ systemPrompt: systemPrompt ?? '' })
    })

    app.post('/preferences', async (c) => {
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)
        const parsed = updatePreferencesSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        if (parsed.data.systemPrompt !== undefined) {
            const value = parsed.data.systemPrompt.trim() || null
            store.preferences.set(namespace, 'systemPrompt', value)
        }

        const systemPrompt = store.preferences.get(namespace, 'systemPrompt')
        return c.json({ systemPrompt: systemPrompt ?? '' })
    })

    return app
}
