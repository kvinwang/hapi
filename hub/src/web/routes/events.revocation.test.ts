import { expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { Store } from '../../store'
import { RevocationCache } from '../../auth/revocationCache'
import { AuthService } from '../../auth/authService'

it('ends an existing SSE stream when its key is revoked', async () => {
    const store = new Store(':memory:')
    const cache = new RevocationCache(store.accessTokens, store.apiKeys)
    const auth = new AuthService(store, cache, new Uint8Array(32), 'unused')
    const visibility = new VisibilityTracker()
    const manager = new SSEManager(0, visibility)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('apiKeyId', 'key'); c.set('accessTokenId', null); await next() })
    app.route('/', createEventsRoutes(() => manager, () => null, () => visibility, auth))
    const response = await app.request('/events')
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    cache.revokeApiKey('key')
    expect((await reader.read()).done).toBe(true)
}, 5000)
