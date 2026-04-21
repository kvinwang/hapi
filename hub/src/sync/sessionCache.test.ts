import { describe, expect, it } from 'bun:test'
import { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { Store } from '../store'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('SessionCache', () => {
    it('ignores stale keepalive events after forcing idle', () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(
            new SSEManager(0, new VisibilityTracker()),
            () => 'default'
        )
        const cache = new SessionCache(store, publisher)

        const session = cache.createSession('test-tag', { path: '/tmp', host: 'host' }, 'default')
        const now = Date.now()

        cache.handleSessionAlive({
            sid: session.id,
            time: now - 1_000,
            thinking: true
        })

        cache.forceIdle(session.id, {
            active: true,
            time: now
        })

        cache.handleSessionAlive({
            sid: session.id,
            time: now - 500,
            thinking: true
        })

        const updated = cache.getSession(session.id)
        expect(updated?.thinking).toBe(false)
        expect(updated?.active).toBe(true)
        expect(updated?.thinkingAt).toBe(now)
    })
})
