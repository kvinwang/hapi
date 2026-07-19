import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const pricingSchema = z.object({
    model: z.string().trim().min(1).max(255),
    inputPerMillion: z.number().finite().nonnegative(),
    outputPerMillion: z.number().finite().nonnegative(),
    cachedInputPerMillion: z.number().finite().nonnegative()
})

export function createModelPricingRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/model-pricing', (c) => c.json({ pricing: store.modelPricing.list(c.get('namespace')) }))

    app.get('/model-pricing/:model', (c) => {
        const pricing = store.modelPricing.get(c.get('namespace'), decodeURIComponent(c.req.param('model')))
        return c.json({ pricing })
    })

    app.put('/model-pricing/:model', async (c) => {
        const model = decodeURIComponent(c.req.param('model')).trim()
        const parsed = pricingSchema.safeParse({ ...(await c.req.json().catch(() => null)), model })
        if (!parsed.success) return c.json({ error: 'Invalid model pricing' }, 400)
        return c.json({ pricing: store.modelPricing.set(c.get('namespace'), parsed.data) })
    })

    app.delete('/model-pricing/:model', (c) => {
        const deleted = store.modelPricing.delete(c.get('namespace'), decodeURIComponent(c.req.param('model')))
        return c.json({ deleted })
    })

    return app
}
