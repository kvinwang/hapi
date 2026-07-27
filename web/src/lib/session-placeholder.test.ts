import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { findCachedSessionSummary, sessionFromSummary } from '@/lib/session-placeholder'

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'session-1',
        parentSessionId: null,
        active: true,
        thinking: false,
        activeAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
        metadata: {
            path: '/home/kvin/src/hapi',
            name: 'hapi',
            machineId: 'machine-1',
            summary: { text: 'Fixing the session page' },
            flavor: 'claude'
        },
        todoProgress: null,
        pendingRequestsCount: 0,
        modelMode: 'default',
        ...overrides
    }
}

describe('sessionFromSummary', () => {
    it('carries over the fields the session header renders', () => {
        const session = sessionFromSummary(makeSummary())

        expect(session.id).toBe('session-1')
        expect(session.active).toBe(true)
        expect(session.metadata?.name).toBe('hapi')
        expect(session.metadata?.path).toBe('/home/kvin/src/hapi')
        expect(session.metadata?.flavor).toBe('claude')
        expect(session.modelMode).toBe('default')
    })

    it('fills the summary timestamp the full metadata shape requires', () => {
        const session = sessionFromSummary(makeSummary())

        expect(session.metadata?.summary).toEqual({
            text: 'Fixing the session page',
            updatedAt: 1_700_000_100_000
        })
    })

    it('leaves fields the summary cannot know empty rather than inventing them', () => {
        const session = sessionFromSummary(makeSummary())

        expect(session.agentState).toBeNull()
        expect(session.todos).toBeUndefined()
        expect(session.metadataVersion).toBe(0)
    })

    it('tolerates a session with no metadata', () => {
        const session = sessionFromSummary(makeSummary({ metadata: null }))

        expect(session.metadata).toBeNull()
    })
})

describe('findCachedSessionSummary', () => {
    it('finds a summary already held by the sessions list query', () => {
        const queryClient = new QueryClient()
        queryClient.setQueryData(queryKeys.sessions, {
            sessions: [makeSummary({ id: 'a' }), makeSummary({ id: 'b' })]
        })

        expect(findCachedSessionSummary(queryClient, 'b')?.id).toBe('b')
    })

    it('returns null for an unknown id, a null id, or an empty cache', () => {
        const queryClient = new QueryClient()
        expect(findCachedSessionSummary(queryClient, 'missing')).toBeNull()
        expect(findCachedSessionSummary(queryClient, null)).toBeNull()

        queryClient.setQueryData(queryKeys.sessions, { sessions: [makeSummary({ id: 'a' })] })
        expect(findCachedSessionSummary(queryClient, 'missing')).toBeNull()
    })
})
