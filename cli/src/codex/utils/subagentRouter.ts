import { randomUUID } from 'node:crypto'
import type { SubagentSessions } from '@/api/subagentSessions'
import { AppServerEventConverter } from './appServerEventConverter'

type Fields = Record<string, unknown>

const asRecord = (value: unknown): Fields | null => value && typeof value === 'object' ? value as Fields : null
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** Notifications seen before the spawn that announces their thread; bounded so stray threads cannot grow it. */
const MAX_PENDING_PER_THREAD = 200

export type CodexThreadOutput = {
    /** Forwards one converted Codex event of a subagent thread to the given sender. */
    forward: (event: Fields, send: (message: unknown) => void, threadId: string) => void
    sendToOwner: (message: unknown) => void
    sendToSession: (message: unknown, sessionId: string) => void
}

/**
 * Splits a Codex app-server stream into the session's own thread and its subagent threads.
 *
 * Subagent threads share the connection and are told apart only by `threadId`. Their spawn and
 * completion are announced as `subAgentActivity` items on the spawning thread; each subagent is
 * keyed by its thread id, which also serves as the call id of the `Agent` card in the parent.
 */
export class CodexSubagentRouter {
    private readonly converters = new Map<string, AppServerEventConverter>()
    private readonly pending = new Map<string, Array<[string, unknown]>>()
    private readonly lastMessage = new Map<string, string>()

    constructor(
        private readonly subagents: SubagentSessions,
        private readonly output: CodexThreadOutput
    ) {}

    /** Returns true when the notification was consumed as subagent traffic. */
    handleNotification(method: string, params: unknown, ownThreadId: string | null): boolean {
        const record = asRecord(params)
        const threadId = str(record?.threadId ?? record?.thread_id)
        if (!threadId || !ownThreadId) return false

        const isOwn = threadId === ownThreadId
        const item = asRecord(record?.item)
        if (item?.type === 'subAgentActivity' && (isOwn || this.subagents.has(threadId))) {
            this.onActivity(method, item, isOwn ? null : threadId)
            return true
        }
        if (isOwn) return false

        if (this.subagents.has(threadId)) {
            this.forward(threadId, method, params)
        } else {
            const queued = this.pending.get(threadId) ?? []
            if (queued.length < MAX_PENDING_PER_THREAD) queued.push([method, params])
            this.pending.set(threadId, queued)
        }
        return true
    }

    private onActivity(method: string, item: Fields, spawnerThreadId: string | null): void {
        const childThreadId = str(item.agentThreadId)
        if (!childThreadId) return
        const sendToSpawner = (message: unknown) => spawnerThreadId
            ? this.subagents.send(spawnerThreadId, (sessionId) => this.output.sendToSession(message, sessionId))
            : this.output.sendToOwner(message)

        if (item.kind === 'started' && method === 'item/started' && !this.subagents.has(childThreadId)) {
            const description = str(item.agentPath)?.split('/').pop() || undefined
            this.subagents.start(childThreadId, { description, parentToolUseId: spawnerThreadId })
            sendToSpawner({ type: 'tool-call', name: 'Agent', callId: childThreadId, input: { description }, id: randomUUID() })
            for (const [queuedMethod, queuedParams] of this.pending.get(childThreadId) ?? []) {
                this.forward(childThreadId, queuedMethod, queuedParams)
            }
            this.pending.delete(childThreadId)
            return
        }

        if ((item.kind === 'completed' || item.kind === 'interrupted') && method === 'item/completed') {
            const summary = this.lastMessage.get(childThreadId)
            const completed = item.kind === 'completed'
            sendToSpawner({
                type: 'tool-call-result',
                callId: childThreadId,
                output: summary ?? item.kind,
                is_error: !completed,
                id: randomUUID()
            })
            this.subagents.end(childThreadId, { status: completed ? 'completed' : 'stopped', summary })
            this.converters.delete(childThreadId)
        }
    }

    private forward(threadId: string, method: string, params: unknown): void {
        let converter = this.converters.get(threadId)
        if (!converter) {
            converter = new AppServerEventConverter()
            this.converters.set(threadId, converter)
        }
        const send = (message: unknown) => this.subagents.send(threadId, (sessionId) => this.output.sendToSession(message, sessionId))
        for (const event of converter.handleNotification(method, params)) {
            const fields = event as Fields
            if (fields.type === 'agent_message' && typeof fields.message === 'string') {
                this.lastMessage.set(threadId, fields.message)
            }
            if (fields.type === 'exec_command_begin') {
                this.subagents.progress(threadId, { activity: str(fields.command) ?? undefined })
            }
            this.output.forward(fields, send, threadId)
        }
    }
}
