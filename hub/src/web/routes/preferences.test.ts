import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createPreferencesRoutes } from './preferences'

function setup() {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'alpha')
        await next()
    })
    app.route('/api', createPreferencesRoutes(new Store(':memory:')))
    const post = (body: unknown) => app.request('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    return { app, post }
}

describe('quick phrases preference', () => {
    it('stores a trimmed, de-duplicated list without touching the system prompt', async () => {
        const { app, post } = setup()
        await post({ systemPrompt: 'be brief' })
        const response = await post({ quickPhrases: [' continue ', 'continue', 'run the tests'] })
        expect(await response.json()).toEqual({ systemPrompt: 'be brief', quickPhrases: ['continue', 'run the tests'] })
        expect(await (await app.request('/api/preferences')).json()).toEqual({
            systemPrompt: 'be brief',
            quickPhrases: ['continue', 'run the tests']
        })

        await post({ quickPhrases: [] })
        expect(await (await app.request('/api/preferences')).json()).toEqual({ systemPrompt: 'be brief', quickPhrases: [] })
    })

    it('rejects blank phrases', async () => {
        const { post } = setup()
        expect((await post({ quickPhrases: ['  '] })).status).toBe(400)
    })
})
