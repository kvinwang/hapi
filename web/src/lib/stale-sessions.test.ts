import { describe, expect, it } from 'vitest'
import { selectStaleSessions, STALE_SESSION_AGE_MS } from './stale-sessions'

const NOW = 1_800_000_000_000
const OLD = NOW - STALE_SESSION_AGE_MS - 1
const RECENT = NOW - 1000

function s(id: string, opts: { parent?: string; active?: boolean; updatedAt?: number; pinned?: boolean } = {}) {
    return {
        id,
        parentSessionId: opts.parent ?? null,
        active: opts.active ?? true,
        updatedAt: opts.updatedAt ?? OLD,
        pinned: opts.pinned
    }
}

const ids = (list: { id: string }[]) => list.map((x) => x.id)

describe('selectStaleSessions', () => {
    it('selects only active, unpinned sessions idle past the cutoff', () => {
        const result = selectStaleSessions([
            s('old'),
            s('recent', { updatedAt: RECENT }),
            s('archived', { active: false }),
            s('pinned', { pinned: true }),
            s('edge', { updatedAt: NOW - STALE_SESSION_AGE_MS })
        ], NOW)
        expect(ids(result)).toEqual(['old'])
    })

    it('skips a stale parent whose archive would kill a recent active child', () => {
        const result = selectStaleSessions([
            s('parent'),
            s('child', { parent: 'parent', updatedAt: RECENT })
        ], NOW)
        expect(ids(result)).toEqual([])
    })

    it('skips a stale parent with a pinned active descendant, but ignores inactive ones', () => {
        expect(ids(selectStaleSessions([
            s('parent'),
            s('child', { parent: 'parent' }),
            s('grandchild', { parent: 'child', pinned: true })
        ], NOW))).toEqual([])

        expect(ids(selectStaleSessions([
            s('parent'),
            s('child', { parent: 'parent', active: false, updatedAt: RECENT })
        ], NOW))).toEqual(['parent'])
    })

    it('orders descendants before their ancestors', () => {
        const result = selectStaleSessions([
            s('root', { updatedAt: OLD - 10 }),
            s('child', { parent: 'root' }),
            s('grandchild', { parent: 'child', updatedAt: OLD - 5 })
        ], NOW)
        expect(ids(result)).toEqual(['grandchild', 'child', 'root'])
    })
})
