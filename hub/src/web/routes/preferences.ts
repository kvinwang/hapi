import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { AUTO_COMPACT_PREFERENCE, autoCompactMinTokens } from '../../sync/autoCompact'

const quickPhrasesSchema = z.array(z.object({
    text: z.string().trim().min(1).max(4000),
    action: z.enum(['insert', 'send'])
})).max(200)

const favoriteListsSchema = z.array(z.object({
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(100)
})).max(100)

const updatePreferencesSchema = z.object({
    systemPrompt: z.string().max(10000).optional(),
    quickPhrases: quickPhrasesSchema.optional(),
    favoriteLists: favoriteListsSchema.optional(),
    dashscopeApiKey: z.string().max(200).optional(),
    /** null turns auto-compact off; 0 compacts every idle Claude session. */
    autoCompactMinTokens: z.number().int().min(0).max(10_000_000).nullable().optional()
})

function readJsonList<T>(store: Store, namespace: string, key: string, schema: z.ZodType<T[]>): T[] {
    const raw = store.preferences.get(namespace, key)
    if (!raw) return []
    try {
        const parsed = schema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : []
    } catch {
        return []
    }
}

export function createPreferencesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const readPreferences = (namespace: string) => ({
        systemPrompt: store.preferences.get(namespace, 'systemPrompt') ?? '',
        quickPhrases: readJsonList(store, namespace, 'quickPhrases', quickPhrasesSchema),
        favoriteLists: readJsonList(store, namespace, 'favoriteLists', favoriteListsSchema),
        // The key itself never leaves the hub.
        dashscopeConfigured: store.preferences.get(namespace, 'dashscopeApiKey') !== null,
        autoCompactMinTokens: autoCompactMinTokens(store.preferences.get(namespace, AUTO_COMPACT_PREFERENCE))
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
        if (parsed.data.favoriteLists !== undefined) {
            const lists = parsed.data.favoriteLists.filter((list, index, all) => all.findIndex((other) => other.id === list.id) === index)
            store.preferences.set(namespace, 'favoriteLists', lists.length > 0 ? JSON.stringify(lists) : null)
        }
        if (parsed.data.dashscopeApiKey !== undefined) {
            store.preferences.set(namespace, 'dashscopeApiKey', parsed.data.dashscopeApiKey.trim() || null)
        }
        if (parsed.data.autoCompactMinTokens !== undefined) {
            store.preferences.set(namespace, AUTO_COMPACT_PREFERENCE, String(parsed.data.autoCompactMinTokens ?? 'off'))
        }

        return c.json(readPreferences(namespace))
    })

    return app
}
