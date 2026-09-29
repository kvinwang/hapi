import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const quickPhrasesSchema = z.array(z.object({
    text: z.string().trim().min(1).max(4000),
    action: z.enum(['insert', 'send'])
})).max(200)

const updatePreferencesSchema = z.object({
    systemPrompt: z.string().max(10000).optional(),
    quickPhrases: quickPhrasesSchema.optional()
})

function readQuickPhrases(store: Store, namespace: string): z.infer<typeof quickPhrasesSchema> {
    const raw = store.preferences.get(namespace, 'quickPhrases')
    if (!raw) return []
    try {
        const parsed = quickPhrasesSchema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : []
    } catch {
        return []
    }
}

export function createPreferencesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const readPreferences = (namespace: string) => ({
        systemPrompt: store.preferences.get(namespace, 'systemPrompt') ?? '',
        quickPhrases: readQuickPhrases(store, namespace)
    })

    app.get('/preferences', (c) => c.json(readPreferences(c.get('namespace'))))

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
        if (parsed.data.quickPhrases !== undefined) {
            const phrases = parsed.data.quickPhrases.filter((phrase, index, all) => all.findIndex((other) => other.text === phrase.text) === index)
            store.preferences.set(namespace, 'quickPhrases', phrases.length > 0 ? JSON.stringify(phrases) : null)
        }

        return c.json(readPreferences(namespace))
    })

    return app
}
