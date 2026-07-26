import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MessageService } from './messageService'

function makeService(name: string): { store: Store; service: MessageService; sessionId: string } {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession(name, { path: '/tmp' }, null, 'default')
    return {
        store,
        service: new MessageService(store, {} as Server, {} as EventPublisher),
        sessionId: session.id
    }
}

describe('MessageService history', () => {
    it('returns the newest matching messages when filtering by role', () => {
        const { store, service, sessionId } = makeService('history-role')
        for (let index = 0; index < 300; index += 1) {
            store.messages.addMessage(sessionId, { role: 'agent', content: `assistant ${index}` })
            if (index % 50 === 0) {
                store.messages.addMessage(sessionId, { role: 'user', content: `user ${index}` })
            }
        }

        const result = service.getSessionHistory(sessionId, { limit: 3, role: 'user' })

        expect(result.messages.map((message) => message.text)).toEqual(['user 150', 'user 200', 'user 250'])
        expect(result.messages.every((message) => message.role === 'user')).toBeTrue()
    })

    it('respects afterSeq and beforeSeq boundaries', () => {
        const { store, service, sessionId } = makeService('history-bounds')
        for (let index = 1; index <= 10; index += 1) {
            store.messages.addMessage(sessionId, { role: 'user', content: `m${index}` })
        }

        const result = service.getSessionHistory(sessionId, { limit: 50, afterSeq: 3, beforeSeq: 7 })

        expect(result.messages.map((message) => message.seq)).toEqual([4, 5, 6])
    })

    it('returns messages oldest first', () => {
        const { store, service, sessionId } = makeService('history-order')
        for (const text of ['first', 'second', 'third']) {
            store.messages.addMessage(sessionId, { role: 'user', content: text })
        }

        const result = service.getSessionHistory(sessionId, { limit: 10 })

        expect(result.messages.map((message) => message.text)).toEqual(['first', 'second', 'third'])
    })
})
