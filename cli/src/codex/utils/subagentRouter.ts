import { randomUUID } from 'node:crypto'
import type { SubagentStatus } from '@hapi/protocol/types'
import type { SubagentSessions } from '@/api/subagentSessions'
import { AppServerEventConverter } from './appServerEventConverter'
import { logger } from '@/ui/logger'

type Fields = Record<string, unknown>

const asRecord = (value: unknown): Fields | null => value && typeof value === 'object' ? value as Fields : null
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

const MAX_PENDING_PER_THREAD = 200
const AGENT_STATUS: Record<string, SubagentStatus> = {
    pendingInit: 'running', running: 'running', completed: 'completed', errored: 'failed',
    interrupted: 'stopped', shutdown: 'stopped', notFound: 'stopped'
}

export type CodexThreadOutput = {
    /** Forwards one converted Codex event of a subagent thread to the given sender. */
    forward: (event: Fields, send: (message: unknown) => void, threadId: string) => void
    subscribe?: (threadId: string) => Promise<unknown>
    sendToOwner: (message: unknown) => void
    sendToSession: (message: unknown, sessionId: string) => void
}

/** Routes both native subagent activity and collaboration tools into read-only child sessions. */
export class CodexSubagentRouter {
    private readonly converters = new Map<string, AppServerEventConverter>()
    private readonly pending = new Map<string, Array<[string, unknown]>>()
    private readonly lastMessage = new Map<string, string>()
    private readonly parents = new Map<string, string | null>()
    private readonly statuses = new Map<string, SubagentStatus>()

    constructor(
        private readonly subagents: SubagentSessions,
        private readonly output: CodexThreadOutput
    ) {}

    /** Returns true when the notification was consumed as subagent traffic. */
    handleNotification(method: string, params: unknown, ownThreadId: string | null): boolean {
        if (!ownThreadId) return false
        const record = asRecord(params)
        const thread = method === 'thread/started' || method === 'thread/resumed' ? asRecord(record?.thread) : null
        const threadId = str(record?.threadId ?? record?.thread_id ?? thread?.id)
        if (!threadId) return false
        const isOwn = threadId === ownThreadId
        if (isOwn) return this.handleActivity(method, asRecord(record?.item), null, ownThreadId)

        const parentId = str(thread?.parentThreadId)
        if (parentId && !this.subagents.has(threadId) && (parentId === ownThreadId || this.subagents.has(parentId))) {
            this.start(threadId, parentId === ownThreadId ? null : parentId,
                str(thread?.agentNickname) ?? str(thread?.name) ?? str(thread?.preview), ownThreadId, str(thread?.agentRole))
        }
        if (this.subagents.has(threadId)) {
            if (thread) this.describe(threadId, thread)
            if (this.handleActivity(method, asRecord(record?.item), threadId, ownThreadId)) return true
            if (method === 'turn/started') this.start(threadId, this.parents.get(threadId) ?? null, undefined, ownThreadId)
            this.forward(threadId, method, params)
        } else {
            const queued = this.pending.get(threadId) ?? []
            if (queued.length < MAX_PENDING_PER_THREAD) queued.push([method, params])
            this.pending.set(threadId, queued)
        }
        return true
    }

    private handleActivity(method: string, item: Fields | null, parent: string | null, ownThreadId: string): boolean {
        if (item?.type === 'subAgentActivity') {
            const id = str(item.agentThreadId)
            if (!id) return true
            if ((item.kind === 'started' && method === 'item/started')
                || (item.kind === 'interacted' && method === 'item/completed')) {
                this.start(id, parent, str(item.agentPath)?.split('/').pop(), ownThreadId)
            } else if (method === 'item/completed' && (item.kind === 'completed' || item.kind === 'interrupted')) {
                this.finish(id, item.kind === 'completed' ? 'completed' : 'stopped')
            }
            return true
        }
        if (item?.type !== 'collabAgentToolCall') return false
        if (method !== 'item/completed' || (item.status !== 'completed' && item.status !== 'failed')) return true
        const states = asRecord(item.agentsStates) ?? {}
        const ids = new Set([
            ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string') : []),
            ...Object.keys(states)
        ])
        for (const id of ids) {
            if (id === ownThreadId || id === parent) continue
            const state = asRecord(states[id])
            const status = AGENT_STATUS[str(state?.status) ?? '']
            const sendsWork = item.status === 'completed' && ['spawnAgent', 'resumeAgent', 'sendInput', 'sendMessage', 'followupTask'].includes(String(item.tool))
            if (!this.subagents.has(id) && ((item.tool === 'spawnAgent' && item.status === 'completed') || (status && state?.status !== 'notFound'))) {
                this.start(id, parent, str(item.prompt), ownThreadId)
            } else if (this.subagents.has(id) && (status === 'running' || (!status && sendsWork))) {
                this.start(id, parent, undefined, ownThreadId)
            }
            if (status && status !== 'running') {
                this.finish(id, status, str(state?.message))
            } else if (!status && (item.tool === 'closeAgent' || item.tool === 'interruptAgent')) {
                this.finish(id, 'stopped')
            }
        }
        return true
    }

    private start(id: string, parent: string | null, description: string | undefined, ownThreadId: string, agentType?: string): void {
        if (this.statuses.get(id) === 'running') return
        const first = !this.subagents.has(id)
        if (first) this.parents.set(id, parent)
        this.statuses.set(id, 'running')
        this.lastMessage.delete(id)
        description = description?.trim().split('\n')[0].slice(0, 160) || undefined
        this.subagents.start(id, { description, agentType, parentToolUseId: parent })
        if (first) {
            this.sendToParent(id, { type: 'tool-call', name: 'Agent', callId: id, input: { description }, id: randomUUID() })
            void this.output.subscribe?.(id).then((thread) => {
                const info = asRecord(thread)
                if (info) this.describe(id, info)
            }).catch((error) => logger.debug(`[codex] Cannot subscribe to subagent ${id}`, error))
        }
        const pending = this.pending.get(id) ?? []
        this.pending.delete(id)
        for (const [method, params] of pending) this.handleNotification(method, params, ownThreadId)
    }

    private describe(id: string, thread: Fields): void {
        const description = str(thread.agentNickname) ?? str(thread.name)
        const agentType = str(thread.agentRole)
        if (description || agentType) this.subagents.describe(id, { description, agentType })
        const model = str(thread.model)
        if (model) this.subagents.model(id, model, str(thread.modelProvider) ?? 'codex')
    }

    private finish(id: string, status: SubagentStatus, summary = this.lastMessage.get(id)): void {
        if (!this.subagents.has(id) || this.statuses.get(id) === status) return
        this.statuses.set(id, status)
        this.sendToParent(id, {
            type: 'tool-call-result', callId: id, output: summary ?? status,
            is_error: status !== 'completed', id: randomUUID()
        })
        this.subagents.end(id, { status, summary })
        this.converters.delete(id)
    }

    private sendToParent(id: string, message: unknown): void {
        const parent = this.parents.get(id)
        if (parent) this.subagents.send(parent, (sessionId) => this.output.sendToSession(message, sessionId))
        else this.output.sendToOwner(message)
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
        const turn = asRecord(asRecord(params)?.turn)
        if (method === 'turn/completed') {
            this.finish(threadId, turn?.status === 'failed' ? 'failed' : turn?.status === 'interrupted' ? 'stopped' : 'completed')
        }
    }
}
