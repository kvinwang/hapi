import { describe, expect, it } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { AUTO_COMPACT_IDLE_MS, autoCompactMinTokens, shouldAutoCompact } from './autoCompact'

const now = 10 * AUTO_COMPACT_IDLE_MS
const session = (overrides: Partial<Session> = {}, contextTokens = 80_000) => ({
    active: true,
    thinking: false,
    metadata: { flavor: 'claude', contextTokens },
    agentState: { controlledByUser: false, requests: {} },
    ...overrides
}) as unknown as Session
const user = (text: string) => ({ content: { role: 'user', content: { type: 'text', text } } })
const idleFor = (ms: number) => ({ createdAt: now - ms })

describe('auto-compact', () => {
    it('compacts a large idle Claude session only while its prompt cache is still warm', () => {
        expect(shouldAutoCompact(session(), 50_000, idleFor(AUTO_COMPACT_IDLE_MS), user('fix it'), now)).toBe(true)
        expect(shouldAutoCompact(session(), 50_000, idleFor(AUTO_COMPACT_IDLE_MS - 60_000), user('fix it'), now)).toBe(false)
        expect(shouldAutoCompact(session(), 50_000, idleFor(3 * AUTO_COMPACT_IDLE_MS), user('fix it'), now)).toBe(false)
    })

    it('skips sessions that are small, busy, local, waiting on the user or already compacted', () => {
        const idle = idleFor(AUTO_COMPACT_IDLE_MS)
        expect(shouldAutoCompact(session({}, 10_000), 50_000, idle, user('fix it'), now)).toBe(false)
        expect(shouldAutoCompact(session({}, 10_000), 0, idle, user('fix it'), now)).toBe(true)
        expect(shouldAutoCompact(session(), null, idle, user('fix it'), now)).toBe(false)
        expect(shouldAutoCompact(session({ thinking: true }), 50_000, idle, user('fix it'), now)).toBe(false)
        expect(shouldAutoCompact(session({ agentState: { controlledByUser: true } }), 50_000, idle, user('fix it'), now)).toBe(false)
        expect(shouldAutoCompact(session({ agentState: { requests: { r: { tool: 'Bash', arguments: {} } } } }), 50_000, idle, user('fix it'), now)).toBe(false)
        expect(shouldAutoCompact(session(), 50_000, idle, user('/compact'), now)).toBe(false)
    })

    it('reads the stored threshold, defaulting when unset', () => {
        expect(autoCompactMinTokens(null)).toBe(50_000)
        expect(autoCompactMinTokens('off')).toBeNull()
        expect(autoCompactMinTokens('0')).toBe(0)
    })
})
