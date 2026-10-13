import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import { SubagentSessions } from '@/api/subagentSessions'
import type { Metadata } from '@/api/types'
import { CodexSubagentRouter } from './subagentRouter'

const ROOT = 'thread-root'
const CHILD = 'thread-child'
const activity = (method: string, kind: string) => [method, {
    threadId: ROOT,
    item: { type: 'subAgentActivity', id: `call-${kind}`, kind, agentThreadId: CHILD, agentPath: '/root/worker' }
}] as const
const childItem = (method: string, item: Record<string, unknown>) => [method, { threadId: CHILD, turnId: 'turn-child', item }] as const
const command = (status: string) => ({ type: 'commandExecution', id: 'exec-1', command: "bash -lc 'echo hi'", cwd: '/repo', status, exitCode: status === 'completed' ? 0 : null })

// Abridged from a real `codex app-server` (0.158) run where the root thread spawns one worker.
const STREAM = [
    ['thread/status/changed', { threadId: CHILD, status: { type: 'idle' } }],
    activity('item/started', 'started'),
    activity('item/completed', 'started'),
    ['turn/started', { threadId: CHILD, turn: { id: 'turn-child' } }],
    childItem('item/started', command('inProgress')),
    childItem('item/completed', command('completed')),
    childItem('item/completed', { type: 'agentMessage', id: 'msg-1', text: 'Output: hi', phase: 'final_answer' }),
    ['turn/completed', { threadId: CHILD, turn: { id: 'turn-child', status: 'completed' } }],
    activity('item/started', 'completed'),
    activity('item/completed', 'completed'),
    ['item/completed', { threadId: ROOT, item: { type: 'agentMessage', id: 'msg-2', text: 'The worker said hi' } }]
] as const

describe('CodexSubagentRouter', () => {
    it('moves a subagent thread into its own session and leaves the root thread alone', async () => {
        let metadata: Metadata = { path: '/repo', host: 'box', flavor: 'codex' }
        const client = {
            sessionId: 'parent',
            getMetadata: () => metadata,
            updateMetadata: (handler: (current: Metadata) => Metadata) => { metadata = handler(metadata) }
        } as unknown as ApiSessionClient
        const api = { getOrCreateSession: vi.fn(async () => ({ id: 'child' })) } as unknown as ApiClient
        const toOwner: unknown[] = []
        const forwarded: Array<{ type: unknown; sessionId: string }> = []
        const router = new CodexSubagentRouter(new SubagentSessions(api, client), {
            forward: (event, send) => send(event),
            sendToOwner: (message) => toOwner.push(message),
            sendToSession: (message, sessionId) => forwarded.push({ type: (message as { type: unknown }).type, sessionId })
        })

        // Everything of the subagent thread, its turn events included, bypasses the root thread's turn tracking.
        const consumed = STREAM.map(([method, params]) => router.handleNotification(method, params, ROOT))
        expect(consumed).toEqual([true, true, true, true, true, true, true, true, true, true, false])

        await vi.waitFor(() => expect(forwarded.some((item) => item.type === 'agent_message')).toBe(true))
        expect(forwarded.every((item) => item.sessionId === 'child')).toBe(true)
        expect(forwarded.map((item) => item.type)).toEqual(expect.arrayContaining(['exec_command_begin', 'exec_command_end', 'agent_message']))

        expect(toOwner).toEqual([
            expect.objectContaining({ type: 'tool-call', name: 'Agent', callId: CHILD, input: { description: 'worker' } }),
            expect.objectContaining({ type: 'tool-call-result', callId: CHILD, output: 'Output: hi', is_error: false })
        ])
        expect(metadata.subagents?.[CHILD]).toMatchObject({ sessionId: 'child', status: 'completed', summary: 'Output: hi', description: 'worker' })
    })
})
