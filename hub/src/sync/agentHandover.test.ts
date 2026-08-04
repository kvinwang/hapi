import { describe, expect, it } from 'bun:test'
import { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { Store } from '../store'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'

const NAMESPACE = 'default'

function makeCache(): { cache: SessionCache; store: Store } {
    const store = new Store(':memory:')
    const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => NAMESPACE)
    return { cache: new SessionCache(store, publisher), store }
}

function makeSession(cache: SessionCache, metadata: Record<string, unknown> = {}) {
    return cache.createSession('tag-1', {
        path: '/tmp/project',
        host: 'test-host',
        flavor: 'claude',
        claudeSessionId: 'claude-thread-1',
        permissionMode: 'plan',
        ...metadata
    }, NAMESPACE)
}

function storedMetadata(store: Store, sessionId: string): Record<string, any> {
    return store.sessions.getSession(sessionId)?.metadata as Record<string, any>
}

describe('SessionCache.recordAgentHandover', () => {
    it('files the outgoing agent state under its own flavor', async () => {
        const { cache, store } = makeCache()
        const session = makeSession(cache)

        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 42, resetContext: false
        })

        expect(storedMetadata(store, session.id).agentDrivers.claude).toEqual({
            lastSeq: 42,
            permissionMode: 'plan',
            modelMode: undefined,
            effortMode: undefined
        })
    })

    it('keeps the outgoing transcript so that agent can resume it later', async () => {
        const { cache, store } = makeCache()
        const session = makeSession(cache)

        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 42, resetContext: false
        })

        expect(storedMetadata(store, session.id).claudeSessionId).toBe('claude-thread-1')
    })

    it('has no transcript to offer an agent that has never driven this session', async () => {
        const { cache } = makeCache()
        const session = makeSession(cache)

        const result = await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 42, resetContext: false
        })

        expect(result.resumeToken).toBeUndefined()
        expect(result.incoming).toBeUndefined()
    })

    it('offers a returning agent its own transcript and the modes it left with', async () => {
        const { cache } = makeCache()
        const session = makeSession(cache, { codexSessionId: 'codex-thread-1' })

        // Claude hands over to Codex...
        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 42, resetContext: false
        })
        // ...and later gets the session back.
        const back = await cache.recordAgentHandover(session.id, {
            fromFlavor: 'codex', toFlavor: 'claude', lastSeq: 77, resetContext: false
        })

        expect(back.resumeToken).toBe('claude-thread-1')
        expect(back.incoming?.lastSeq).toBe(42)
        expect(back.incoming?.permissionMode).toBe('plan')
    })

    it('drops the incoming transcript when the caller asks for a clean start', async () => {
        const { cache, store } = makeCache()
        const session = makeSession(cache, { codexSessionId: 'codex-thread-1' })

        const result = await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 42, resetContext: true
        })

        expect(result.resumeToken).toBeUndefined()
        expect(result.incoming).toBeUndefined()
        // Left behind, it would silently reattach on the next handover.
        expect(storedMetadata(store, session.id).codexSessionId).toBeUndefined()
    })

    it('leaves the other agents alone when one is reset', async () => {
        const { cache, store } = makeCache()
        const session = makeSession(cache, { codexSessionId: 'codex-thread-1' })

        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 42, resetContext: true
        })

        expect(storedMetadata(store, session.id).claudeSessionId).toBe('claude-thread-1')
    })

    it('preserves unrelated metadata across a handover', async () => {
        const { cache, store } = makeCache()
        const session = makeSession(cache, { name: 'my session', machineId: 'machine-1' })

        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'grok', lastSeq: 1, resetContext: false
        })

        const metadata = storedMetadata(store, session.id)
        expect(metadata.name).toBe('my session')
        expect(metadata.machineId).toBe('machine-1')
        expect(metadata.path).toBe('/tmp/project')
    })

    it('accumulates a driver entry per agent that has driven the session', async () => {
        const { cache, store } = makeCache()
        const session = makeSession(cache)

        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 10, resetContext: false
        })
        await cache.recordAgentHandover(session.id, {
            fromFlavor: 'codex', toFlavor: 'grok', lastSeq: 20, resetContext: false
        })

        const drivers = storedMetadata(store, session.id).agentDrivers
        expect(Object.keys(drivers).sort()).toEqual(['claude', 'codex'])
        expect(drivers.claude.lastSeq).toBe(10)
        expect(drivers.codex.lastSeq).toBe(20)
    })

    it('rejects a handover for a session it does not know', async () => {
        const { cache } = makeCache()

        await expect(cache.recordAgentHandover('nope', {
            fromFlavor: 'claude', toFlavor: 'codex', lastSeq: 0, resetContext: false
        })).rejects.toThrow('Session not found')
    })
})
