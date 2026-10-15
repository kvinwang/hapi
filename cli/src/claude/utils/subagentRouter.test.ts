import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import { SubagentSessions } from '@/api/subagentSessions'
import type { Metadata } from '@/api/types'
import type { SDKMessage } from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'
import { SDKToLogConverter } from './sdkToLogConverter'
import { ClaudeSubagentRouter } from './subagentRouter'

const AGENT_ID = 'toolu_agent'

// Abridged from a real `claude -p --output-format stream-json` run of a foreground subagent.
const STREAM: SDKMessage[] = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: AGENT_ID, name: 'Agent', input: { description: 'Run echo', prompt: 'Run echo hi' } }] } },
    { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: AGENT_ID, description: 'Run echo', subagent_type: 'general-purpose', is_backgrounded: false, task_type: 'local_agent', prompt: 'Run echo hi' },
    { type: 'user', parent_tool_use_id: AGENT_ID, message: { role: 'user', content: [{ type: 'text', text: 'Run echo hi' }] } },
    { type: 'system', subtype: 'task_progress', tool_use_id: AGENT_ID, description: 'Running echo', usage: { total_tokens: 100, tool_uses: 1, duration_ms: 900 } },
    { type: 'assistant', parent_tool_use_id: AGENT_ID, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo hi' } }] } },
    { type: 'user', parent_tool_use_id: AGENT_ID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'hi' }] } },
    { type: 'system', subtype: 'task_notification', tool_use_id: AGENT_ID, status: 'completed', summary: 'Output: hi', usage: { total_tokens: 150, tool_uses: 1, duration_ms: 3000 } }
]

function setup(stream: SDKMessage[] = STREAM) {
    let metadata: Metadata = { path: '/repo', host: 'box', flavor: 'claude', claudeSessionId: 'parent-claude', summary: { text: 'Parent', updatedAt: 1 } }
    const client = {
        sessionId: 'parent',
        getMetadata: () => metadata,
        updateMetadata: (handler: (current: Metadata) => Metadata) => { metadata = handler(metadata) }
    } as unknown as ApiSessionClient
    const getOrCreateSession = vi.fn(async () => ({ id: 'child' }))
    const api = { getOrCreateSession } as unknown as ApiClient
    const sent: Array<{ sessionId: string; log: RawJSONLines }> = []
    const converter = new SDKToLogConverter({ sessionId: 'claude', cwd: '/repo', version: '1', gitBranch: 'main' })
    const router = new ClaudeSubagentRouter(new SubagentSessions(api, client), converter, (log, sessionId) => sent.push({ sessionId, log }))

    for (const message of stream) {
        router.observe(message)
        if (message.parent_tool_use_id) {
            router.route(message.parent_tool_use_id, converter.convert(message)!)
        }
    }
    return { getOrCreateSession, sent, metadata: () => metadata, router }
}

describe('ClaudeSubagentRouter', () => {
    it('mirrors a subagent into a read-only child session', async () => {
        const { getOrCreateSession, sent, metadata } = setup()
        await vi.waitFor(() => expect(sent).toHaveLength(4))

        expect(getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
            tag: `subagent:parent:${AGENT_ID}`,
            parentSessionId: 'parent',
            metadata: expect.objectContaining({
                name: 'Run echo',
                summary: undefined,
                claudeSessionId: undefined,
                subagent: { ownerSessionId: 'parent', toolUseId: AGENT_ID }
            })
        }))

        expect(sent.every((item) => item.sessionId === 'child' && item.log.isSidechain === false)).toBe(true)
        expect(sent.map((item) => item.log.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
        // The prompt comes from task_started (the stream's copy is dropped); the report closes the transcript.
        expect(sent[0].log).toMatchObject({ parentUuid: null, message: { content: 'Run echo hi' } })
        expect(sent[3].log).toMatchObject({ message: { content: [{ type: 'text', text: 'Output: hi' }] } })

        expect(metadata().subagents?.[AGENT_ID]).toMatchObject({
            sessionId: 'child',
            status: 'completed',
            agentType: 'general-purpose',
            description: 'Run echo',
            summary: 'Output: hi',
            totalTokens: 150,
            durationMs: 3000
        })
    })

    it('marks a finished subagent running again when SendMessage resumes it', async () => {
        const { sent, metadata, router } = setup()
        await vi.waitFor(() => expect(sent).toHaveLength(4))

        // A resumed task keeps its task_id but reports the SendMessage call as its tool_use_id.
        router.observe({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_send', is_backgrounded: true, task_type: 'local_agent', prompt: 'Again' })
        expect(metadata().subagents?.[AGENT_ID]).toMatchObject({ status: 'running', summary: undefined, endedAt: undefined })
        await vi.waitFor(() => expect(sent).toHaveLength(5))
        expect(sent[4].log).toMatchObject({ message: { content: 'Again' } })

        router.observe({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_send', status: 'completed', summary: 'Done again' })
        expect(metadata().subagents?.[AGENT_ID]).toMatchObject({ status: 'completed', summary: 'Done again' })
    })

    it('drops heartbeats of long-running tools', () => {
        const converter = new SDKToLogConverter({ sessionId: 'claude', cwd: '/repo', version: '1', gitBranch: 'main' })
        const heartbeat = { type: 'tool_progress', tool_use_id: 'toolu_bash-heartbeat-0', parent_tool_use_id: 'toolu_bash' } as unknown as SDKMessage
        expect(converter.convert(heartbeat)).toBeNull()
    })

    it('ignores non-subagent tools such as background Bash', () => {
        const getOrCreateSession = vi.fn()
        const converter = new SDKToLogConverter({ sessionId: 'claude', cwd: '/repo', version: '1', gitBranch: 'main' })
        const router = new ClaudeSubagentRouter(
            new SubagentSessions({ getOrCreateSession } as unknown as ApiClient, { sessionId: 'parent' } as ApiSessionClient),
            converter,
            () => {}
        )
        router.observe({ type: 'system', subtype: 'task_started', tool_use_id: 'toolu_bash', task_type: 'local_bash' })
        router.route('toolu_bash', converter.convert({ type: 'assistant', parent_tool_use_id: 'toolu_bash', message: { role: 'assistant', content: [] } })!)
        expect(getOrCreateSession).not.toHaveBeenCalled()
    })
})
