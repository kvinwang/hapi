import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

type PageCall = Parameters<SyncEngine['getMessagesPage']>[1]

function makeApp(engine: Partial<SyncEngine>) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createMessagesRoutes(() => engine as SyncEngine))
    return app
}

function stubEngine(overrides: Partial<SyncEngine> = {}): Partial<SyncEngine> {
    return {
        resolveSessionAccess: (sessionId: string) => ({
            ok: true,
            sessionId,
            session: { id: sessionId, active: true }
        }),
        ...overrides
    } as Partial<SyncEngine>
}

describe('GET /api/sessions/:id/messages', () => {
    it('passes toolGroups=1 through to the sync engine', async () => {
        const calls: PageCall[] = []
        const app = makeApp(stubEngine({
            getMessagesPage: (_sessionId, options) => {
                calls.push(options)
                return { messages: [], page: { limit: options.limit, beforeSeq: null, nextBeforeSeq: null, afterSeq: null, nextAfterSeq: null, hasMore: false } }
            }
        }))

        const response = await app.request('/api/sessions/s1/messages?limit=25&toolGroups=1')

        expect(response.status).toBe(200)
        expect(calls[0]).toEqual({ limit: 25, beforeSeq: null, afterSeq: null, role: undefined, toolGroups: true })
    })

    it('defaults toolGroups to off', async () => {
        const calls: PageCall[] = []
        const app = makeApp(stubEngine({
            getMessagesPage: (_sessionId, options) => {
                calls.push(options)
                return { messages: [], page: { limit: options.limit, beforeSeq: null, nextBeforeSeq: null, afterSeq: null, nextAfterSeq: null, hasMore: false } }
            }
        }))

        await app.request('/api/sessions/s1/messages')

        expect(calls[0].toolGroups).toBe(false)
        expect(calls[0].limit).toBe(50)
    })

    it('rejects beforeSeq and afterSeq together', async () => {
        const app = makeApp(stubEngine({ getMessagesPage: () => { throw new Error('should not run') } }))

        const response = await app.request('/api/sessions/s1/messages?beforeSeq=5&afterSeq=2')

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'beforeSeq and afterSeq cannot be used together' })
    })
})

describe('GET /api/sessions/:id/tool-group-messages', () => {
    it('returns the raw messages for the requested span', async () => {
        const app = makeApp(stubEngine({
            getToolGroupMessages: (_sessionId, span) => [
                { id: 'm1', seq: span.firstSeq, localId: null, content: { role: 'agent' }, createdAt: 1 }
            ]
        }))

        const response = await app.request('/api/sessions/s1/tool-group-messages?firstSeq=4&lastSeq=9')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ messages: [{ id: 'm1', seq: 4, localId: null, content: { role: 'agent' }, createdAt: 1 }] })
    })

    it('rejects a missing span', async () => {
        const app = makeApp(stubEngine({ getToolGroupMessages: () => { throw new Error('should not run') } }))

        const response = await app.request('/api/sessions/s1/tool-group-messages?firstSeq=4')

        expect(response.status).toBe(400)
    })
})
