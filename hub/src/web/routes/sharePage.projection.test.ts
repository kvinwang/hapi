import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { Store } from '../../store'
import { MessageService } from '../../sync/messageService'
import type { EventPublisher } from '../../sync/eventPublisher'
import { exportSessionShareJson, loadAllMessages, renderShareData, renderShareMarkdown } from './sharePage'

/**
 * The chat page ships a projection of each message. Export, the shared page and
 * its `fmt=md` / `fmt=json` bodies read the store directly and must keep the
 * whole record — the long command, the file body, the thinking signature.
 */

const LONG_COMMAND = `echo ${'x'.repeat(400)} && ls -la /very/long/path/that/keeps/going`

function seed(): { store: Store; service: MessageService; sessionId: string } {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession(
        `share-projection-${Math.random().toString(36).slice(2)}`,
        { path: '/repo' },
        null,
        'default'
    )
    const add = (content: unknown) => store.messages.addMessage(session.id, content)

    add({ role: 'user', content: { type: 'text', text: 'run it' } })
    for (const id of ['a', 'b']) {
        add({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    cwd: '/repo',
                    sessionId: 'claude-session',
                    message: {
                        model: 'claude-test',
                        content: [
                            { type: 'thinking', thinking: '', signature: 'SIGNATURE-KEEP-ME' },
                            { type: 'tool_use', id, name: 'Bash', input: { command: LONG_COMMAND } }
                        ]
                    }
                }
            }
        })
        add({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'y'.repeat(5_000) }] }
                }
            }
        })
    }
    add({ role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } } } })

    return {
        store,
        service: new MessageService(store, {} as Server, {} as EventPublisher),
        sessionId: session.id
    }
}

describe('page projection stays out of export and the shared page', () => {
    it('trims the chat page', () => {
        const { service, sessionId } = seed()
        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })
        const serialized = JSON.stringify(page.messages)

        expect(serialized).not.toContain('SIGNATURE-KEEP-ME')
        expect(serialized).not.toContain(LONG_COMMAND)
        // The row still shows the head of the command.
        expect(serialized).toContain('echo xxx')
    })

    it('exports the whole record', () => {
        const { store, sessionId } = seed()
        const exported = exportSessionShareJson(store, sessionId)
        const serialized = JSON.stringify(exported)

        expect(serialized).toContain(LONG_COMMAND)
        expect(loadAllMessages(store, sessionId)).toHaveLength(6)
    })

    it('renders markdown from the whole record', () => {
        const { store, sessionId } = seed()
        const session = store.sessions.getSession(sessionId)!
        const markdown = renderShareMarkdown(renderShareData(session, loadAllMessages(store, sessionId)))

        expect(markdown).toContain(LONG_COMMAND)
    })
})
