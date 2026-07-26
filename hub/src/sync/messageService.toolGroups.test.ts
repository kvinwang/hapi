import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { getToolGroupSpan, type ToolGroupContent } from '@hapi/protocol/chat'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { MessageService } from './messageService'

function userText(text: string) {
    return { role: 'user', content: { type: 'text', text } }
}

function assistantText(text: string) {
    return {
        role: 'agent',
        content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }
    }
}

function toolCall(id: string, name = 'Read', input: unknown = { file_path: `/${id}.ts` }, usage?: unknown) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: `api-${id}`,
                    content: [{ type: 'tool_use', id, name, input }],
                    ...(usage ? { usage } : {})
                }
            }
        }
    }
}

function reasoning(text: string) {
    return {
        role: 'agent',
        content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: text }] } } }
    }
}

function toolResult(id: string, output = 'x'.repeat(20_000)) {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] }
            }
        }
    }
}

function makeService(): { store: Store; service: MessageService; sessionId: string } {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession(
        `tool-group-${Math.random().toString(36).slice(2)}`,
        { path: '/tmp' },
        null,
        'default'
    )
    return {
        store,
        service: new MessageService(store, {} as Server, {} as EventPublisher),
        sessionId: session.id
    }
}

/** Seeds `runs` tool runs of `toolsPerRun` tools, each separated by chat text. */
function seedSession(store: Store, sessionId: string, runs: number, toolsPerRun: number): void {
    for (let run = 0; run < runs; run += 1) {
        store.messages.addMessage(sessionId, userText(`prompt ${run}`))
        for (let tool = 0; tool < toolsPerRun; tool += 1) {
            const id = `t${run}-${tool}`
            store.messages.addMessage(sessionId, toolCall(id))
            store.messages.addMessage(sessionId, toolResult(id))
        }
        store.messages.addMessage(sessionId, assistantText(`done ${run}`))
    }
}

function groupContent(message: { content: unknown }): ToolGroupContent | null {
    const content = message.content as { content?: ToolGroupContent } | null
    const inner = content?.content
    return inner && inner.type === 'tool-group' ? inner : null
}

describe('tool-group message pages', () => {
    it('never starts a page in the middle of a tool run', () => {
        const { store, service, sessionId } = makeService()
        seedSession(store, sessionId, 4, 10)

        let beforeSeq: number | null = null
        let guard = 0
        const seenRuns: string[] = []

        while (guard < 50) {
            guard += 1
            const page = service.getMessagesPage(sessionId, {
                limit: 5,
                beforeSeq,
                afterSeq: null,
                toolGroups: true
            })
            for (const message of page.messages) {
                const group = groupContent(message)
                if (group) seenRuns.push(group.tools.map((tool) => tool.id).join(','))
            }
            if (!page.page.hasMore || page.page.nextBeforeSeq === null) break
            beforeSeq = page.page.nextBeforeSeq
        }

        // Every run of ten tools came back whole, never split across pages.
        const expected = [3, 2, 1, 0].map((run) =>
            Array.from({ length: 10 }, (_, tool) => `t${run}-${tool}`).join(',')
        )
        expect(seenRuns).toEqual(expected)
    })

    it('collapses a completed run into one message and drops result bodies', () => {
        const { store, service, sessionId } = makeService()
        seedSession(store, sessionId, 1, 12)

        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })

        // prompt + group + assistant text
        expect(page.messages).toHaveLength(3)
        const group = groupContent(page.messages[1])
        expect(group).not.toBeNull()
        expect(group!.tools).toHaveLength(12)
        expect(group!.tools.every((tool) => tool.state === 'completed')).toBeTrue()
        expect(group!.tools.every((tool) => tool.resultPending)).toBeTrue()

        const raw = service.getMessagesPage(sessionId, { limit: 50, beforeSeq: null, afterSeq: null })
        expect(JSON.stringify(page.messages).length).toBeLessThan(JSON.stringify(raw.messages).length / 10)
    })

    it('leaves the live tail run raw so new tool calls join the rendered card', () => {
        const { store, service, sessionId } = makeService()
        store.messages.addMessage(sessionId, userText('go'))
        for (const id of ['a', 'b', 'c']) {
            store.messages.addMessage(sessionId, toolCall(id))
            store.messages.addMessage(sessionId, toolResult(id))
        }

        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })
        expect(page.messages.some((message) => groupContent(message) !== null)).toBeFalse()
        expect(page.messages).toHaveLength(7)
    })

    it('reports the covered span so paging cursors skip the whole run', () => {
        const { store, service, sessionId } = makeService()
        seedSession(store, sessionId, 2, 4)

        const page = service.getMessagesPage(sessionId, {
            limit: 3,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })
        const group = page.messages.map(groupContent).find((entry) => entry !== null)
        expect(group).toBeTruthy()
        expect(getToolGroupSpan((page.messages.find((message) => groupContent(message))!).content))
            .toEqual({ firstSeq: group!.firstSeq, lastSeq: group!.lastSeq })
        expect(page.page.nextBeforeSeq).toBe(Math.min(
            group!.firstSeq,
            ...page.messages.map((message) => (groupContent(message) ? group!.firstSeq : message.seq!))
        ))
    })

    it('never ends a forward page in the middle of a tool run', () => {
        const { store, service, sessionId } = makeService()
        seedSession(store, sessionId, 3, 8)

        let afterSeq = 0
        let guard = 0
        const seenRuns: string[] = []

        while (guard < 50) {
            guard += 1
            const page = service.getMessagesPage(sessionId, {
                limit: 4,
                beforeSeq: null,
                afterSeq,
                toolGroups: true
            })
            for (const message of page.messages) {
                const group = groupContent(message)
                if (group) seenRuns.push(group.tools.map((tool) => tool.id).join(','))
            }
            if (!page.page.hasMore || page.page.nextAfterSeq === null || page.page.nextAfterSeq <= afterSeq) break
            afterSeq = page.page.nextAfterSeq
        }

        expect(seenRuns).toEqual([0, 1, 2].map((run) =>
            Array.from({ length: 8 }, (_, tool) => `t${run}-${tool}`).join(',')
        ))
    })

    it('serves the raw messages behind a group on demand', () => {
        const { store, service, sessionId } = makeService()
        seedSession(store, sessionId, 1, 3)

        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })
        const group = page.messages.map(groupContent).find((entry) => entry !== null)!
        const raw = service.getToolGroupMessages(sessionId, {
            firstSeq: group.firstSeq,
            lastSeq: group.lastSeq
        })
        expect(raw).toHaveLength(6)
        expect(JSON.stringify(raw)).toContain('x'.repeat(1_000))
    })

    it('keeps the token usage of the messages it folds away', () => {
        const { store, service, sessionId } = makeService()
        store.messages.addMessage(sessionId, userText('go'))
        for (const id of ['a', 'b', 'c']) {
            store.messages.addMessage(sessionId, toolCall(id, 'Read', { file_path: `/${id}.ts` }, {
                input_tokens: 10,
                output_tokens: 2,
                cache_read_input_tokens: 1
            }))
            store.messages.addMessage(sessionId, toolResult(id))
        }
        store.messages.addMessage(sessionId, assistantText('done'))

        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })
        const group = page.messages.map(groupContent).find((entry) => entry !== null)!

        expect(group.usage).toEqual({
            input_tokens: 30,
            output_tokens: 6,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 3
        })
    })

    it('keeps reasoning messages that sit inside a compacted run', () => {
        const { store, service, sessionId } = makeService()
        store.messages.addMessage(sessionId, userText('go'))
        store.messages.addMessage(sessionId, toolCall('a'))
        store.messages.addMessage(sessionId, toolResult('a'))
        store.messages.addMessage(sessionId, reasoning('thinking about it'))
        store.messages.addMessage(sessionId, toolCall('b'))
        store.messages.addMessage(sessionId, toolResult('b'))
        store.messages.addMessage(sessionId, assistantText('done'))

        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })

        // prompt + group + reasoning + assistant text
        expect(page.messages).toHaveLength(4)
        expect(JSON.stringify(page.messages)).toContain('thinking about it')
    })

    it('delivers a run containing a subagent call raw', () => {
        const { store, service, sessionId } = makeService()
        store.messages.addMessage(sessionId, userText('go'))
        store.messages.addMessage(sessionId, toolCall('a', 'Task', { prompt: 'investigate' }))
        store.messages.addMessage(sessionId, toolResult('a'))
        store.messages.addMessage(sessionId, toolCall('b'))
        store.messages.addMessage(sessionId, toolResult('b'))
        store.messages.addMessage(sessionId, assistantText('done'))

        const page = service.getMessagesPage(sessionId, {
            limit: 50,
            beforeSeq: null,
            afterSeq: null,
            toolGroups: true
        })

        expect(page.messages.some((message) => groupContent(message) !== null)).toBeFalse()
        expect(page.messages).toHaveLength(6)
    })

    it('leaves pages untouched when the caller does not opt in', () => {
        const { store, service, sessionId } = makeService()
        seedSession(store, sessionId, 1, 5)

        const page = service.getMessagesPage(sessionId, { limit: 4, beforeSeq: null, afterSeq: null })
        expect(page.messages).toHaveLength(4)
        expect(page.messages.some((message) => groupContent(message) !== null)).toBeFalse()
    })
})
