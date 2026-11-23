import { describe, expect, it } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import type { StoredMessage } from '../store'
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
const idleFor = (ms: number, usage?: object) => [{ id: 'm', seq: 1, localId: null, createdAt: now - ms, content: { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: 'u', isSidechain: false, message: { id: 'msg', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage } } } } }] as unknown as StoredMessage[]

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

    it('falls back to the latest turn usage when the CLI does not report context size', () => {
        const unreported = session({ metadata: { flavor: 'claude' } } as Partial<Session>)
        const idle = idleFor(AUTO_COMPACT_IDLE_MS, { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 120_000 })
        expect(shouldAutoCompact(unreported, 100_000, idle, user('fix it'), now)).toBe(true)
        expect(shouldAutoCompact(unreported, 200_000, idle, user('fix it'), now)).toBe(false)
        const compacted = [...idle, { ...idle[0], seq: 2, content: user('/compact').content }, { ...idleFor(AUTO_COMPACT_IDLE_MS, { input_tokens: 0 })[0], seq: 3 }] as StoredMessage[]
        expect(shouldAutoCompact(unreported, 100_000, compacted, user('<local-command-stdout>Compacted </local-command-stdout>'), now)).toBe(false)
    })

    it('reads the stored threshold, defaulting when unset', () => {
        expect(autoCompactMinTokens(null)).toBe(50_000)
        expect(autoCompactMinTokens('off')).toBeNull()
        expect(autoCompactMinTokens('0')).toBe(0)
    })
})
