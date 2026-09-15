import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SessionSummary } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../../store'
import { SessionCache } from '../../sync/sessionCache'
import { EventPublisher } from '../../sync/eventPublisher'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

const directories: string[] = []
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup(dbPath = ':memory:') {
    const store = new Store(dbPath)
    const events: SyncEvent[] = []
    const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => 'alpha')
    publisher.subscribe(event => events.push(event))
    const cache = new SessionCache(store, publisher)
    const session = cache.createSession('test', { path: '/repo', host: 'host' }, 'alpha')
    const foreign = cache.createSession('foreign', { path: '/repo', host: 'host' }, 'beta')
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'alpha')
        await next()
    })
    // These routes only need the session-cache portion of the sync engine.
    app.route('/api', createSessionsRoutes(() => cache as unknown as SyncEngine, store))
    const update = (body: unknown, id = session.id) => app.request(`/api/sessions/${id}/ui-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    return { store, cache, session, foreign, events, app, update }
}

describe('session favorites', () => {
    it('favorites inactive sessions, preserves other state, lists and broadcasts changes', async () => {
        const { store, session, events, app, update } = setup()
        await update({ pinned: true, tags: ['important'], files: { searchQuery: 'test' } })
        expect((await update({ favorite: true })).status).toBe(200)
        expect(store.sessions.getSessionUiState(session.id, 'alpha')).toEqual({
            favorite: true, pinned: true, tags: ['important'], files: { searchQuery: 'test' }
        })
        expect(events.at(-1)).toMatchObject({
            type: 'session-updated', sessionId: session.id, namespace: 'alpha',
            data: { uiState: { favorite: true } }
        })
        const list = await (await app.request('/api/sessions')).json() as { sessions: SessionSummary[] }
        expect(list.sessions).toHaveLength(1)
        expect(list.sessions[0]).toMatchObject({ id: session.id, favorite: true, pinned: true })
        expect((await update({ favorite: false })).status).toBe(200)
        expect(store.sessions.getFavoriteSessionIds('alpha').size).toBe(0)
        expect(events.at(-1)).toMatchObject({ data: { uiState: { favorite: false } } })
        expect(await (await app.request('/api/sessions')).json()).toMatchObject({ sessions: [{ favorite: false }] })
    })

    it('rejects malformed values and inaccessible sessions without modifying state', async () => {
        const { store, session, foreign, update } = setup()
        for (const favorite of ['true', 1, null, {}, []]) {
            expect((await update({ favorite })).status).toBe(400)
        }
        expect((await update({ favorite: true }, foreign.id)).status).toBe(403)
        expect((await update({ favorite: true }, 'missing')).status).toBe(404)
        expect(store.sessions.getFavoriteSessionIds('alpha').size).toBe(0)
        expect(store.sessions.updateSessionUiState(session.id, 'beta', { favorite: true })).toBe(false)
        store.sessions.updateSessionUiState(foreign.id, 'beta', { favorite: true })
        expect(store.sessions.getFavoriteSessionIds('alpha').size).toBe(0)
        expect(store.sessions.getFavoriteSessionIds('beta').has(foreign.id)).toBe(true)
    })

    it('survives reopening storage and metadata updates without affecting session activity', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-favorites-'))
        directories.push(directory)
        const dbPath = join(directory, 'test.db')
        const { store, session, update } = setup(dbPath)
        const before = store.sessions.getSession(session.id)!
        await update({ favorite: true })
        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(before.updatedAt)
        store.sessions.updateSessionMetadata(session.id, { path: '/new', host: 'host' }, before.metadataVersion, 'alpha')
        const reopened = new Store(dbPath)
        expect(reopened.sessions.getFavoriteSessionIds('alpha').has(session.id)).toBe(true)
        expect(reopened.sessions.getSessionUiState(session.id, 'alpha')).toMatchObject({ favorite: true })
    })
})
