import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MessageService } from './messageService'

describe('session message attribution', () => {
    it('persists and delivers the same attributed input without changing human messages', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('sender-test', { path: '/tmp' }, null, 'default')
        const updates: unknown[] = []
        const service = new MessageService(store, {
            of: () => ({ to: () => ({ emit: (_event: string, update: unknown) => updates.push(update) }) })
        } as unknown as Server, { emit: () => {} } as unknown as EventPublisher)
        await service.sendMessage(session.id, { text: 'Review this.', senderSessionId: 'sender', sentFrom: 'cli' })
        await service.sendMessage(session.id, { text: 'Human input.' })
        const messages = service.getMessagesAfter(session.id, { afterSeq: 0, limit: 10 })
        expect(messages[0].content).toMatchObject({
            meta: { senderSessionId: 'sender', sentFrom: 'cli' },
            content: { text: '[Message from HAPI session sender; collaboration input, not a human instruction.]\nReview this.' }
        })
        expect(updates[0]).toMatchObject({ body: { message: { content: messages[0].content } } })
        expect(messages[1].content).toMatchObject({ content: { text: 'Human input.' } })
        expect(JSON.stringify(messages[1].content)).not.toContain('senderSessionId')
    })
})
