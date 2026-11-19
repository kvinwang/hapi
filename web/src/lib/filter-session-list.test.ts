import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { filterSessionList } from './filter-session-list'

function session(id: string, favorite: boolean, active: boolean, tags: string[] = []): SessionSummary {
    return {
        id, favorite, active, tags, thinking: false, activeAt: 1, updatedAt: 1,
        metadata: null, todoProgress: null, pendingRequestsCount: 0
    }
}

const active = session('active', false, true)
const favorite = session('favorite', true, false, ['Important'])
const child = { ...session('child', true, false), parentSessionId: active.id }
const sessions = [active, favorite, child]
const base = { sessions, archivedFilteredSessions: [active], listFilter: 'all', tagSearch: '' }

describe('filterSessionList', () => {
    it('respects the archive filter outside search and favorites', () => {
        expect(filterSessionList(base)).toEqual([active])
    })
    it('includes archived favorites and children of non-favorites', () => {
        expect(filterSessionList({ ...base, listFilter: 'favorites' })).toEqual([favorite, child])
    })
    it('intersects favorites with case-insensitive tag search', () => {
        expect(filterSessionList({ ...base, listFilter: 'favorites', tagSearch: ' IMPORTANT ' })).toEqual([favorite])
    })
    it('keeps tag searches independent of the archive filter', () => {
        expect(filterSessionList({ ...base, tagSearch: 'important' })).toEqual([favorite])
    })
    it('filters by list membership and keeps the archive filter', () => {
        const listed = { ...active, lists: ['work'] }
        const closed = { ...favorite, lists: ['work'] }
        expect(filterSessionList({ ...base, sessions: [listed, closed], archivedFilteredSessions: [listed], listFilter: 'work' })).toEqual([listed])
    })
    it('returns an empty list when no favorites match', () => {
        expect(filterSessionList({ ...base, listFilter: 'favorites', sessions: [active] })).toEqual([])
    })
})
