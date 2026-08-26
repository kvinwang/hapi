import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('MessageStore role filtering', () => {
    it('searches matching messages only within the requested session', () => {
        const store = new Store(':memory:')
        const first = store.sessions.getOrCreateSession('search-first', { path: '/tmp' }, null, 'default')
        const second = store.sessions.getOrCreateSession('search-second', { path: '/tmp' }, null, 'default')

        store.messages.addMessage(first.id, { role: 'user', content: 'needle older' })
        const latest = store.messages.addMessage(first.id, { role: 'agent', content: 'needle latest' })
        store.messages.addMessage(second.id, { role: 'user', content: 'needle other session' })

        const matches = store.messages.searchMessages(first.id, 'needle', { limit: 1 })

        expect(matches.map((message) => message.id)).toEqual([latest.id])
    })

    it('uses the latest cumulative Claude result cost across the full session', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('cost-test', { path: '/tmp' }, null, 'default')
        const result = (cost: number) => ({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'result', total_cost_usd: cost }
            }
        })

        store.messages.addMessage(session.id, result(10.6102615))
        for (let i = 0; i < 250; i++) {
            store.messages.addMessage(session.id, { role: 'agent', content: { type: 'output', data: { type: 'assistant' } } })
        }
        store.messages.addMessage(session.id, result(13.0435315))

        expect(store.messages.getClaudeReportedCost(session.id)).toBeCloseTo(13.0435315)
    })

    it('stores inferred roles and filters by role + beforeSeq', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('role-test', { path: '/tmp' }, null, 'default')

        const user1 = store.messages.addMessage(session.id, { role: 'user', content: 'u1' })
        const assistant1 = store.messages.addMessage(session.id, { role: 'agent', content: 'a1' })
        const user2 = store.messages.addMessage(session.id, { role: 'user', content: 'u2' })
        const tool1 = store.messages.addMessage(session.id, { role: 'tool', content: 't1' })

        const users = store.messages.getMessages(session.id, 50, undefined, 'user')
        expect(users.map((m) => m.id)).toEqual([user1.id, user2.id])
        expect(users.every((m) => m.role === 'user')).toBeTrue()

        const usersBeforeThird = store.messages.getMessages(session.id, 50, user2.seq, 'user')
        expect(usersBeforeThird.map((m) => m.id)).toEqual([user1.id])

        const assistants = store.messages.getMessages(session.id, 50, undefined, 'assistant')
        expect(assistants.map((m) => m.id)).toEqual([assistant1.id])

        const tools = store.messages.getMessages(session.id, 50, undefined, 'tool')
        expect(tools.map((m) => m.id)).toEqual([tool1.id])

        const usersAfterFirst = store.messages.getMessagesAfter(session.id, user1.seq, 50, 'user')
        expect(usersAfterFirst.map((m) => m.id)).toEqual([user2.id])
    })
})
