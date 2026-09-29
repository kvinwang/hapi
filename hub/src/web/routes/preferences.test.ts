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
        const response = await post({
            quickPhrases: [
                { text: ' continue ', action: 'send' },
                { text: 'continue', action: 'insert' },
                { text: 'run the tests', action: 'insert' }
            ]
        })
        const expected = {
            systemPrompt: 'be brief',
            quickPhrases: [{ text: 'continue', action: 'send' }, { text: 'run the tests', action: 'insert' }]
        }
        expect(await response.json()).toEqual(expected)
        expect(await (await app.request('/api/preferences')).json()).toEqual(expected)

        await post({ quickPhrases: [] })
        expect(await (await app.request('/api/preferences')).json()).toEqual({ systemPrompt: 'be brief', quickPhrases: [] })
    })

    it('rejects blank phrases and unknown actions', async () => {
        const { post } = setup()
        expect((await post({ quickPhrases: [{ text: '  ', action: 'send' }] })).status).toBe(400)
        expect((await post({ quickPhrases: [{ text: 'hi', action: 'paste' }] })).status).toBe(400)
    })
})
