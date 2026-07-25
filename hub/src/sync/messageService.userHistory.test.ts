import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MessageService } from './messageService'

describe('MessageService user history', () => {
    it('returns lightweight ordered entries and reports truncation', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('user-history-test', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(session.id, { role: 'user', content: 'first' })
        store.messages.addMessage(session.id, { role: 'agent', content: 'assistant' })
        store.messages.addMessage(session.id, { role: 'user', content: 'second' })
        const service = new MessageService(
            store,
            {} as Server,
            {} as EventPublisher
        )

        const result = service.getUserMessageHistory(session.id, 1)

        expect(result.truncated).toBeTrue()
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].text).toBe('first')
        expect(Object.keys(result.messages[0])).toEqual(['id', 'seq', 'createdAt', 'text'])
    })
})
