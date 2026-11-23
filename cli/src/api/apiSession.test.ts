import { describe, expect, it } from 'vitest'
import { isExternalUserMessage } from './apiSession'

describe('isExternalUserMessage', () => {
    const baseUserMsg = {
        type: 'user' as const,
        uuid: 'test-uuid',
        userType: 'external' as const,
        isSidechain: false,
        message: { role: 'user', content: 'hello' },
    }

    it('returns true for a real user text message', () => {
        expect(isExternalUserMessage(baseUserMsg)).toBe(true)
    })

    it('returns false when isMeta is true (skill injections)', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isMeta: true })).toBe(false)
    })

    it('returns false when isSidechain is true', () => {
        expect(isExternalUserMessage({ ...baseUserMsg, isSidechain: true })).toBe(false)
    })

    it('returns false when content is an array (tool results)', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
            } as never)
        ).toBe(false)
    })

    it('returns false for assistant messages', () => {
        expect(
            isExternalUserMessage({
                type: 'assistant',
                uuid: 'test-uuid',
                message: { role: 'assistant', content: 'hi' },
            } as never)
        ).toBe(false)
    })

    // System-injected content detection
    it('returns false for <task-notification> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<task-notification>\n<task-id>abc123</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })

    it('returns false for <command-name> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<command-name>/clear</command-name>' },
            })
        ).toBe(false)
    })

    it('returns false for <local-command-caveat> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' },
            })
        ).toBe(false)
    })

    it('returns false for <system-reminder> messages', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '<system-reminder>\nToday is 2026.\n</system-reminder>' },
            })
        ).toBe(false)
    })

    it('returns true for user text that mentions XML-like strings but is not injected', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: 'How do I use the <task-notification> tag?' },
            })
        ).toBe(true)
    })

    it('returns false for <task-notification> with leading whitespace', () => {
        expect(
            isExternalUserMessage({
                ...baseUserMsg,
                message: { role: 'user', content: '  \n<task-notification>\n<task-id>x</task-id>\n</task-notification>' },
            })
        ).toBe(false)
    })
})

describe('reconnect backfill', () => {
    it('does not feed back user messages this process wrote, such as a compaction summary', async () => {
        const { ApiSessionClient } = await import('./apiSession')
        const client = new ApiSessionClient('token', { id: 's1', metadata: { flavor: 'claude' }, metadataVersion: 0, agentState: null, agentStateVersion: 0 } as never)
        const emitted: Array<{ localId?: string }> = []
        const received: string[] = []
        const internals = client as unknown as {
            socket: { emit: (event: string, payload: { localId?: string }) => void }
            handleIncomingMessage: (message: { seq: number; localId?: string | null; content: unknown }) => void
            getThreadContext: () => Promise<string>
        }
        internals.getThreadContext = async () => ''
        internals.socket.emit = (_event, payload) => { emitted.push(payload) }
        client.onUserMessage((message) => received.push(message.content.text))
        client.sendClaudeSessionMessage({ ...baseSummary, message: { role: 'user', content: 'This session is being continued…' } } as never)
        const user = (text: string) => ({ role: 'user', content: { type: 'text', text } })
        internals.handleIncomingMessage({ seq: 1, localId: emitted[0].localId, content: user('This session is being continued…') })
        internals.handleIncomingMessage({ seq: 2, localId: 'web-1', content: user('/compact') })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(received).toEqual(['/compact'])
        client.close()
    })
})

const baseSummary = { type: 'user', uuid: 'summary-uuid', userType: 'external', isSidechain: false }
