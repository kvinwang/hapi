import { describe, expect, it } from 'vitest'
import type { Session, SessionsResponse } from '@/types/api'
import { mergeSessionsResponse } from '@/lib/session-cache'

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
