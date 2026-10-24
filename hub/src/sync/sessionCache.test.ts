import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol/types'
import { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { Store } from '../store'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('SessionCache', () => {
    it('forks root sessions as children and child sessions as siblings', () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(
            new SSEManager(0, new VisibilityTracker()),
            () => 'default'
        )
        const cache = new SessionCache(store, publisher)
        const metadata = { path: '/tmp', host: 'host', flavor: 'claude' }

        const root = cache.createSession('root', metadata, 'default')
        const childFork = cache.forkSession(root.id, 0, 'default')
        expect(cache.getSession(childFork.sessionId)?.parentSessionId).toBe(root.id)

        const siblingFork = cache.forkSession(childFork.sessionId, 0, 'default')
        expect(cache.getSession(siblingFork.sessionId)?.parentSessionId).toBe(root.id)
    })

    it('forks with the agent and private transcript that drove the selected message range', () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => 'default')
        const cache = new SessionCache(store, publisher)
        const source = cache.createSession('source', {
            path: '/tmp',
            host: 'host',
            flavor: 'codex',
            codexSessionId: 'codex-current',
            agentDriverSegments: [{
                fromSeq: 0,
                toSeq: 10,
                flavor: 'claude',
                sessionId: 'claude-at-fork'
            }]
        }, 'default')

        const fork = cache.forkSession(source.id, 5, 'default')

        expect(fork.metadata.flavor).toBe('claude')
        expect(fork.sourceAgentSessionId).toBe('claude-at-fork')
        expect(fork.metadata.agentDriverSegments).toEqual([{
            fromSeq: 0,
            toSeq: 5,
            flavor: 'claude',
            sessionId: 'claude-at-fork'
        }])
    })

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

    it('accumulates each distinct session summary as a tag', async () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(
            new SSEManager(0, new VisibilityTracker()),
            () => 'default'
        )
        const cache = new SessionCache(store, publisher)
        const session = cache.createSession('test-tag', { path: '/tmp', host: 'host' }, 'default')

        await cache.setSessionSummary(session.id, 'Investigate scroll anchoring')
        await cache.setSessionSummary(session.id, 'Deploy scroll anchoring fix')
        await cache.setSessionSummary(session.id, 'Deploy scroll anchoring fix')

        expect(store.sessions.getSessionTags('default').get(session.id)).toEqual([
            'Investigate scroll anchoring',
            'Deploy scroll anchoring fix'
        ])
    })
})

describe('pruneEmptySessions', () => {
    function makeCache() {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => 'default')
        return { store, cache: new SessionCache(store, publisher) }
    }

    it('deletes sessions that never carried a message', async () => {
        const { store, cache } = makeCache()
        const empty = cache.createSession('empty', { path: '/tmp' }, 'default')
        const used = cache.createSession('used', { path: '/tmp' }, 'default')
        store.messages.addMessage(used.id, { role: 'user', content: { type: 'text', text: 'hi' } })

        expect(await cache.pruneEmptySessions('default', { dryRun: true }))
            .toEqual({ found: 1, deleted: 0, failed: 0 })
        expect(await cache.pruneEmptySessions('default')).toEqual({ found: 1, deleted: 1, failed: 0 })
        expect(cache.getSession(empty.id)).toBeUndefined()
        expect(cache.getSession(used.id)).toBeDefined()
    })

    it('never offers a running session', async () => {
        const { cache } = makeCache()
        const running = cache.createSession('running', { path: '/tmp' }, 'default')
        cache.handleSessionAlive({ sid: running.id, time: Date.now(), thinking: false })

        expect(await cache.pruneEmptySessions('default', { dryRun: true }))
            .toEqual({ found: 0, deleted: 0, failed: 0 })
        expect(cache.getSession(running.id)).toBeDefined()
    })

    it('broadcasts only the changed subagent entries when nothing else changed', () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => 'default')
        const cache = new SessionCache(store, publisher)
        const entry = (status: 'running' | 'completed', activity?: string) => ({ status, startedAt: 1, activity })
        const base = { path: '/tmp', host: 'host', subagents: { a: entry('running', 'Read'), b: entry('running') } }
        const session = cache.createSession('tag', base, 'default')

        const events: SyncEvent[] = []
        publisher.subscribe((event) => events.push(event))
        const write = (metadata: object) => {
            const version = cache.getSession(session.id)!.metadataVersion
            store.sessions.updateSessionMetadata(session.id, metadata, version, 'default')
            cache.refreshSession(session.id)
        }

        write({ ...base, subagents: { a: entry('running', 'Edit'), b: entry('running') } })
        expect(events.at(-1)).toMatchObject({
            type: 'subagent-updated',
            sessionId: session.id,
            data: { subagents: { a: { activity: 'Edit' } } }
        })
        expect(Object.keys((events.at(-1) as { data: { subagents: object } }).data.subagents)).toEqual(['a'])

        write({ ...base, subagents: { a: entry('completed') } })
        expect(events.at(-1)).toMatchObject({ type: 'subagent-updated', data: { removed: ['b'] } })

        write({ ...base, name: 'renamed', subagents: { a: entry('completed') } })
        expect(events.at(-1)).toMatchObject({ type: 'session-updated', data: { metadata: { name: 'renamed' } } })
        expect(cache.getSession(session.id)?.metadata?.subagents).toEqual({ a: entry('completed') })
    })

    it('keeps heartbeat fields and modes out of the way of subagent deltas', () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => 'default')
        const cache = new SessionCache(store, publisher)
        const entry = (activity: string) => ({ status: 'running' as const, startedAt: 1, activity })
        const base = { path: '/tmp', host: 'host', subagents: { a: entry('Read') } }
        const session = cache.createSession('tag', base, 'default')
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true, effortMode: 'high', permissionMode: 'default' })

        const events: SyncEvent[] = []
        publisher.subscribe((event) => events.push(event))
        const write = (metadata: { subagents: object }) => {
            // As the CLI does: its current metadata (incl. the modes the hub persisted), new subagents.
            const current = cache.getSession(session.id)!
            store.sessions.updateSessionMetadata(session.id, { ...current.metadata, subagents: metadata.subagents }, current.metadataVersion, 'default')
            cache.refreshSession(session.id)
        }

        write({ ...base, subagents: { a: entry('Edit') } })
        expect(events.map((event) => event.type)).toEqual(['subagent-updated'])
        expect(cache.getSession(session.id)?.effortMode).toBe('high')

        cache.handleSessionAlive({ sid: session.id, time: Date.now() + 1, thinking: false, effortMode: 'high', permissionMode: 'default' })
        events.length = 0
        write({ ...base, subagents: { a: entry('Bash') } })
        expect(events.map((event) => event.type)).toEqual(['subagent-updated'])

        // The same metadata written again: only the bookkeeping, as a tiny patch.
        events.length = 0
        write({ ...base, subagents: { a: entry('Bash') } })
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ type: 'session-updated' })
        const patch = (events[0] as { data: Record<string, unknown> }).data
        expect(patch).toMatchObject({ metadataVersion: cache.getSession(session.id)!.metadataVersion })
        // updatedAt only when the write landed in a later millisecond
        expect(Object.keys(patch).filter((key) => key !== 'updatedAt').sort()).toEqual(['metadataVersion', 'seq'])

        // A permission request arrives as a patch with the agent state, without the metadata.
        events.length = 0
        const stateVersion = cache.getSession(session.id)!.agentStateVersion
        store.sessions.updateSessionAgentState(session.id, { requests: { r1: { tool: 'Bash', arguments: {} } } }, stateVersion, 'default')
        cache.refreshSession(session.id)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ type: 'session-updated', data: { agentState: { requests: { r1: { tool: 'Bash' } } } } })
        expect((events[0] as { data: Record<string, unknown> }).data.metadata).toBeUndefined()

        // Nothing changed at all: nothing is sent.
        events.length = 0
        cache.refreshSession(session.id)
        expect(events).toHaveLength(0)
    })
})
