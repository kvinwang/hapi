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


function setupRouter(subscribe?: (threadId: string) => Promise<unknown>) {
    let metadata: Metadata = { path: '/repo', host: 'box', flavor: 'codex' }
    const client = {
        sessionId: 'parent', getMetadata: () => metadata, updateSessionMetadata: vi.fn(async () => {}),
        updateMetadata: (handler: (current: Metadata) => Metadata) => { metadata = handler(metadata) }
    } as unknown as ApiSessionClient
    const create = vi.fn(async ({ tag }: { tag: string }) => ({ id: tag, metadata: null, metadataVersion: 0 }))
    const api = { getOrCreateSession: create } as unknown as ApiClient
    const toOwner: unknown[] = []
    const toChild: Array<{ message: unknown; sessionId: string }> = []
    const router = new CodexSubagentRouter(new SubagentSessions(api, client), {
        subscribe,
        forward: (event, send) => send(event),
        sendToOwner: (message) => toOwner.push(message),
        sendToSession: (message, sessionId) => toChild.push({ message, sessionId })
    })
    const collab = (tool: string, states: Record<string, { status: string; message?: string }>, receiverThreadIds = [CHILD], parent = ROOT) => {
        return router.handleNotification('item/completed', {
            threadId: parent,
            item: { type: 'collabAgentToolCall', id: 'call-1', tool, status: 'completed', receiverThreadIds, agentsStates: states, prompt: 'Inspect the implementation' }
        }, ROOT)
    }
    return { router, create, toOwner, toChild, collab, entries: () => metadata.subagents }
}

describe('Codex collaboration tools', () => {
    it('discovers the child on spawn completion and keeps it running until its own work finishes', async () => {
        const { router, collab, entries, toOwner, create } = setupRouter()
        router.handleNotification('item/started', {
            threadId: ROOT,
            item: { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: [], agentsStates: {} }
        }, ROOT)
        expect(entries()).toBeUndefined()
        expect(collab('spawnAgent', { [CHILD]: { status: 'pendingInit' } })).toBe(true)
        await vi.waitFor(() => expect(entries()?.[CHILD].sessionId).toBeDefined())
        expect(entries()?.[CHILD]).toMatchObject({ status: 'running', description: 'Inspect the implementation' })
        expect(toOwner).toHaveLength(1)
        // A timed-out wait has no receiver ids or states; it is not a completion.
        collab('wait', {}, [])
        expect(entries()?.[CHILD].status).toBe('running')
        collab('wait', { [CHILD]: { status: 'completed', message: 'The implementation is correct' } }, [])
        expect(entries()?.[CHILD]).toMatchObject({ status: 'completed', summary: 'The implementation is correct' })
        expect(toOwner).toHaveLength(2)
        expect(create).toHaveBeenCalledOnce()
    })

    it('resumes the same child without duplicate cards and maps failures and shutdown', () => {
        const { collab, entries, toOwner, create } = setupRouter()
        collab('spawnAgent', { [CHILD]: { status: 'running' } })
        collab('wait', { [CHILD]: { status: 'errored', message: 'Worker failed' } }, [])
        expect(entries()?.[CHILD]).toMatchObject({ status: 'failed', summary: 'Worker failed' })
        collab('resumeAgent', {})
        expect(entries()?.[CHILD]).toMatchObject({ status: 'running' })
        expect(entries()?.[CHILD].summary).toBeUndefined()
        collab('closeAgent', { [CHILD]: { status: 'shutdown' } })
        expect(entries()?.[CHILD].status).toBe('stopped')
        expect(toOwner.filter((message) => (message as { type: string }).type === 'tool-call')).toHaveLength(1)
        expect(create).toHaveBeenCalledOnce()
    })

    it('drains early child traffic including nested spawn events into the correct sessions', async () => {
        const { router, collab, entries, toChild, create } = setupRouter()
        const grandchild = 'thread-grandchild'
        collab('spawnAgent', { [grandchild]: { status: 'running' } }, [grandchild], CHILD)
        router.handleNotification('item/completed', {
            threadId: grandchild, item: { type: 'agentMessage', id: 'answer', text: 'Nested result' }
        }, ROOT)
        collab('spawnAgent', { [CHILD]: { status: 'running' } })
        await vi.waitFor(() => expect(entries()?.[grandchild].sessionId).toBeDefined())
        expect(create).toHaveBeenCalledWith(expect.objectContaining({
            tag: `subagent:parent:${grandchild}`, parentSessionId: `subagent:parent:${CHILD}`
        }))
        expect(toChild).toContainEqual(expect.objectContaining({
            sessionId: `subagent:parent:${grandchild}`, message: expect.objectContaining({ type: 'agent_message', message: 'Nested result' })
        }))
    })

    it('uses a child thread announcement without changing the root thread and deduplicates activity formats', async () => {
        const { router, collab, entries, create, toOwner } = setupRouter()
        expect(router.handleNotification('thread/started', { thread: { id: ROOT } }, ROOT)).toBe(false)
        expect(router.handleNotification('thread/started', {
            thread: { id: CHILD, parentThreadId: ROOT, agentNickname: 'Mencius', agentRole: 'worker' }
        }, ROOT)).toBe(true)
        collab('spawnAgent', { [CHILD]: { status: 'running' } })
        router.handleNotification(...activity('item/started', 'started'), ROOT)
        router.handleNotification(...childItem('item/completed', { type: 'agentMessage', id: 'result', text: 'Done' }), ROOT)
        router.handleNotification('turn/completed', { threadId: CHILD, turn: { status: 'completed' } }, ROOT)
        router.handleNotification(...activity('item/completed', 'completed'), ROOT)
        await vi.waitFor(() => expect(entries()?.[CHILD].sessionId).toBeDefined())
        expect(entries()?.[CHILD]).toMatchObject({ description: 'Mencius', agentType: 'worker', status: 'completed', summary: 'Done' })
        expect(create).toHaveBeenCalledOnce()
        expect(toOwner).toHaveLength(2)
    })

    it('does not invent a child for failed spawns or missing agents', () => {
        const { router, collab, entries } = setupRouter()
        router.handleNotification('item/completed', {
            threadId: ROOT, item: { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'failed', receiverThreadIds: [], agentsStates: {} }
        }, ROOT)
        collab('wait', { missing: { status: 'notFound' } }, [])
        expect(entries()).toBeUndefined()
    })

    it('subscribes once to child progress and applies its nickname without reviving completed work', async () => {
        let resolve!: (thread: unknown) => void
        const subscribe = vi.fn(() => new Promise((done) => { resolve = done }))
        const { router, collab, entries } = setupRouter(subscribe)
        collab('spawnAgent', { [CHILD]: { status: 'pendingInit' } })
        collab('wait', { [CHILD]: { status: 'completed', message: 'Done' } }, [])
        router.handleNotification('thread/resumed', { thread: { id: CHILD, parentThreadId: ROOT, agentNickname: 'Mencius' } }, ROOT)
        resolve({ id: CHILD, agentNickname: 'Mencius', agentRole: 'worker' })
        await vi.waitFor(() => expect(entries()?.[CHILD].description).toBe('Mencius'))
        expect(entries()?.[CHILD]).toMatchObject({ status: 'completed', summary: 'Done', agentType: 'worker' })
        collab('resumeAgent', { [CHILD]: { status: 'running' } })
        expect(subscribe).toHaveBeenCalledExactlyOnceWith(CHILD)
    })

})
