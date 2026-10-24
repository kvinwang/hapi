import { describe, expect, it } from 'vitest'
import type { Session, SessionsResponse } from '@/types/api'
import { mergeSessionResponse, mergeSessionsResponse, mergeSubagentDelta } from '@/lib/session-cache'

describe('mergeSessionsResponse', () => {
    it('preserves list-only fields when a live full-session update arrives', () => {
        const current: SessionsResponse = {
            sessions: [{
                id: 'session-1',
                parentSessionId: null,
                active: false,
                thinking: false,
                activeAt: 1,
                updatedAt: 1,
                metadata: { path: '/repo' },
                todoProgress: null,
                pendingRequestsCount: 0,
                totalCost: 1.23,
                favorite: true,
                pinned: true,
                tags: ['important']
            }]
        }
        const liveSession = {
            id: 'session-1',
            namespace: 'default',
            parentSessionId: null,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            seq: 2,
            metadataVersion: 1,
            agentStateVersion: 1,
            thinking: true,
            thinkingAt: 2,
            metadata: { path: '/repo', host: 'host' }
        } as Session

        const merged = mergeSessionsResponse(current, liveSession.id, liveSession)

        expect(merged?.sessions[0]).toMatchObject({
            active: true,
            thinking: true,
            totalCost: 1.23,
            favorite: true,
            pinned: true,
            tags: ['important']
        })
    })

    it('applies tags from an incremental session update', () => {
        const current: SessionsResponse = {
            sessions: [{
                id: 'session-1',
                active: false,
                thinking: false,
                activeAt: 1,
                updatedAt: 1,
                metadata: { path: '/repo' },
                todoProgress: null,
                pendingRequestsCount: 0,
                tags: ['first summary']
            }]
        }

        const merged = mergeSessionsResponse(current, 'session-1', {
            tags: ['first summary', 'second summary']
        })

        expect(merged?.sessions[0]?.tags).toEqual(['first summary', 'second summary'])
    })
    it('applies live favorite changes, including removal, without dropping tags', () => {
        const current: SessionsResponse = { sessions: [{
            id: 'session-1', active: false, thinking: false, activeAt: 1, updatedAt: 1,
            metadata: null, todoProgress: null, pendingRequestsCount: 0, tags: ['keep']
        }] }
        const favorited = mergeSessionsResponse(current, 'session-1', { uiState: { favorite: true } })
        expect(favorited?.sessions[0]).toMatchObject({ favorite: true, tags: ['keep'] })
        const unchanged = mergeSessionsResponse(favorited, 'session-1', { uiState: { pinned: true } })
        expect(unchanged?.sessions[0]?.favorite).toBe(true)
        const removed = mergeSessionsResponse(unchanged, 'session-1', { uiState: { favorite: false } })
        expect(removed?.sessions[0]).toMatchObject({ favorite: false, tags: ['keep'] })
    })

})

describe('mergeSubagentDelta', () => {
    const session = {
        id: 'session-1',
        namespace: 'default',
        parentSessionId: null,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        seq: 1,
        metadataVersion: 3,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        metadata: {
            path: '/repo',
            host: 'host',
            name: 'kept',
            subagents: {
                a: { status: 'running' as const, startedAt: 1, activity: 'Read' },
                b: { status: 'running' as const, startedAt: 1 },
                c: { status: 'completed' as const, startedAt: 1 }
            }
        }
    } as Session

    it('replaces changed entries, removes dropped ones and keeps the rest', () => {
        const merged = mergeSubagentDelta({ session }, {
            metadataVersion: 4,
            updatedAt: 2,
            subagents: { a: { status: 'completed', startedAt: 1, summary: 'done' } },
            removed: ['b']
        })
        expect(merged?.session.metadataVersion).toBe(4)
        expect(merged?.session.metadata?.name).toBe('kept')
        expect(merged?.session.metadata?.subagents).toEqual({
            a: { status: 'completed', startedAt: 1, summary: 'done' },
            c: { status: 'completed', startedAt: 1 }
        })
    })

    it('ignores a delta older than the cached session', () => {
        const current = { session }
        expect(mergeSubagentDelta(current, { metadataVersion: 2, updatedAt: 2, subagents: {} })).toBe(current)
    })

    it('keeps the subagents through a patch without metadata, then applies the next delta', () => {
        const patched = mergeSessionResponse({ session }, {
            metadataVersion: 4,
            seq: 2,
            updatedAt: 2,
            agentState: { requests: { r1: { tool: 'Bash', arguments: {} } } }
        })
        expect(patched?.session.metadata?.subagents?.a?.activity).toBe('Read')
        expect(patched?.session.agentState?.requests?.r1?.tool).toBe('Bash')
        const merged = mergeSubagentDelta(patched, {
            metadataVersion: 4,
            updatedAt: 3,
            subagents: { a: { status: 'running', startedAt: 1, activity: 'Edit' } }
        })
        expect(merged?.session.metadata?.subagents?.a?.activity).toBe('Edit')
        expect(merged?.session.agentState?.requests?.r1?.tool).toBe('Bash')
    })
})
