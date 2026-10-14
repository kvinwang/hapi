import { isSubagentToolName } from '@hapi/protocol/chat'
import type { SubagentStatus } from '@hapi/protocol/types'
import type { SubagentSessions } from '@/api/subagentSessions'
import type { SDKAssistantMessage, SDKMessage } from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'
import type { SDKToLogConverter } from './sdkToLogConverter'

type Fields = Record<string, unknown>

const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' ? value : undefined

function usageFields(event: Fields) {
    const usage = (event.usage ?? {}) as Fields
    return { totalTokens: num(usage.total_tokens), toolUses: num(usage.tool_uses), durationMs: num(usage.duration_ms) }
}

function subagentStatus(status: unknown): SubagentStatus {
    return status === 'completed' || status === 'failed' ? status : 'stopped'
}

/** The subagent's prompt arrives as text blocks; a plain string renders it as the child's user message. */
function flattenPrompt(log: RawJSONLines): RawJSONLines {
    if (log.type !== 'user' || !Array.isArray(log.message.content)) return log
    const blocks = log.message.content as Array<{ type: string; text?: string }>
    if (blocks.length === 0 || !blocks.every((block) => block.type === 'text')) return log
    return { ...log, message: { ...log.message, content: blocks.map((block) => block.text ?? '').join('\n\n') } }
}

function hasText(log: RawJSONLines): boolean {
    return log.type === 'assistant'
        && Array.isArray(log.message?.content)
        && (log.message.content as Array<{ type: string }>).some((block) => block.type === 'text')
}

/**
 * Routes a Claude session's subagent transcripts (messages tagged with `parent_tool_use_id`) into
 * child sessions and tracks their lifecycle from the SDK's `task_*` system events.
 */
export class ClaudeSubagentRouter {
    /** Subagent tool calls seen so far, mapped to the subagent they ran in (null at top level). */
    private readonly subagentCalls = new Map<string, string | null>()
    private readonly lastRoutedHadText = new Map<string, boolean>()
    /** Prompts sent from `task_started`; the stream repeats them only for foreground subagents. */
    private readonly prompts = new Map<string, string>()

    constructor(
        private readonly subagents: SubagentSessions,
        private readonly converter: SDKToLogConverter,
        private readonly send: (log: RawJSONLines, sessionId: string) => void
    ) {}

    observe(message: SDKMessage): void {
        if (message.type === 'assistant') {
            const assistant = message as SDKAssistantMessage
            for (const block of assistant.message.content ?? []) {
                if (block.type === 'tool_use' && block.id && block.name && isSubagentToolName(block.name)) {
                    this.subagentCalls.set(block.id, assistant.parent_tool_use_id ?? null)
                }
            }
            return
        }
        if (message.type !== 'system') return

        const event = message as unknown as Fields
        const toolUseId = str(event.tool_use_id)
        if (!toolUseId || !this.subagentCalls.has(toolUseId)) return

        switch (event.subtype) {
            case 'task_started': {
                this.subagents.start(toolUseId, {
                    agentType: str(event.subagent_type),
                    description: str(event.description),
                    background: event.is_backgrounded === true,
                    parentToolUseId: this.subagentCalls.get(toolUseId)
                })
                const prompt = str(event.prompt)
                if (prompt) {
                    this.routeConverted(toolUseId, { type: 'user', message: { role: 'user', content: prompt } })
                    this.prompts.set(toolUseId, prompt)
                }
                break
            }
            case 'task_progress':
                this.subagents.progress(toolUseId, { activity: str(event.description), ...usageFields(event) })
                break
            case 'task_notification': {
                // A foreground subagent's final report only reaches the parent as the tool result.
                const summary = str(event.summary)
                if (summary && !this.lastRoutedHadText.get(toolUseId)) {
                    this.routeConverted(toolUseId, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: summary }] } })
                }
                this.subagents.end(toolUseId, { status: subagentStatus(event.status), summary, ...usageFields(event) })
                break
            }
        }
    }

    /** Drops anything not from a subagent, e.g. heartbeats Claude Code tags with the long-running tool's own id. */
    route(toolUseId: string, log: RawJSONLines): void {
        if (!this.subagentCalls.has(toolUseId)) return
        const body = flattenPrompt(log)
        if (body.type === 'user' && body.message.content === this.prompts.get(toolUseId)) {
            this.prompts.delete(toolUseId)
            return
        }
        this.lastRoutedHadText.set(toolUseId, hasText(body))
        this.subagents.send(toolUseId, (sessionId) => this.send(body, sessionId))
    }

    private routeConverted(toolUseId: string, message: SDKMessage): void {
        const log = this.converter.convert({ ...message, parent_tool_use_id: toolUseId })
        if (log) this.route(toolUseId, log)
    }
}
