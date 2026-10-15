import type { SubagentEntry } from '@hapi/protocol/types'
import { logger } from '@/ui/logger'
import type { ApiClient } from './api'
import type { ApiSessionClient } from './apiSession'
import { childSessionMetadata } from './childMetadata'

export type SubagentStart = {
    agentType?: string
    description?: string
    background?: boolean
    /** The spawning tool call of the subagent that spawned this one, for nested subagents. */
    parentToolUseId?: string | null
}

const MAX_SUMMARY_LENGTH = 500
const MAX_ACTIVITY_LENGTH = 160

function truncate(text: string | undefined, max: number): string | undefined {
    return text && text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Mirrors an agent's subagents into read-only child sessions.
 *
 * Each subagent, keyed by the tool call that spawned it, gets a child session that receives its
 * transcript, while its status lives in the owner session's `metadata.subagents` so the parent's
 * tool card can show progress and link to the child.
 */
export class SubagentSessions {
    private readonly childIds = new Map<string, Promise<string | null>>()

    constructor(
        private readonly api: ApiClient,
        private readonly client: ApiSessionClient
    ) {}

    has(toolUseId: string): boolean {
        return this.childIds.has(toolUseId)
    }

    start(toolUseId: string, info: SubagentStart): void {
        if (this.childIds.has(toolUseId)) {
            // Resumed after finishing, e.g. via SendMessage.
            this.patch(toolUseId, { status: 'running', summary: undefined, endedAt: undefined, background: info.background })
            return
        }
        this.patch(toolUseId, {
            status: 'running',
            startedAt: Date.now(),
            agentType: info.agentType,
            description: info.description,
            background: info.background
        })
        this.childIds.set(toolUseId, this.createChild(toolUseId, info))
    }

    /** Runs `emit` with the child session id once it exists, preserving call order per subagent. */
    send(toolUseId: string, emit: (sessionId: string) => void): void {
        if (!this.childIds.has(toolUseId)) {
            this.start(toolUseId, {})
        }
        void this.childIds.get(toolUseId)!.then((sessionId) => {
            if (sessionId) emit(sessionId)
        })
    }

    progress(toolUseId: string, update: Pick<SubagentEntry, 'activity' | 'totalTokens' | 'toolUses' | 'durationMs'>): void {
        if (!this.childIds.has(toolUseId)) return
        this.patch(toolUseId, { ...update, activity: truncate(update.activity, MAX_ACTIVITY_LENGTH) })
    }

    end(toolUseId: string, result: Pick<SubagentEntry, 'status' | 'summary' | 'totalTokens' | 'toolUses' | 'durationMs'>): void {
        if (!this.childIds.has(toolUseId)) return
        this.patch(toolUseId, {
            ...result,
            summary: truncate(result.summary, MAX_SUMMARY_LENGTH),
            activity: undefined,
            endedAt: Date.now()
        })
    }

    /** Marks subagents still running as stopped: they die with the agent process. */
    stopRunning(): void {
        this.client.updateMetadata((metadata) => {
            const entries = Object.entries(metadata.subagents ?? {})
            if (!entries.some(([, entry]) => entry.status === 'running')) return metadata
            return {
                ...metadata,
                subagents: Object.fromEntries(entries.map(([id, entry]) => [
                    id,
                    entry.status === 'running' ? { ...entry, status: 'stopped' as const, activity: undefined } : entry
                ]))
            }
        })
    }

    private patch(toolUseId: string, patch: Partial<SubagentEntry>): void {
        this.client.updateMetadata((metadata) => {
            const current = metadata.subagents?.[toolUseId]
            if (!current && patch.status !== 'running') return metadata
            return {
                ...metadata,
                subagents: { ...metadata.subagents, [toolUseId]: { ...current, ...patch } as SubagentEntry }
            }
        })
    }

    private async createChild(toolUseId: string, info: SubagentStart): Promise<string | null> {
        const ownerSessionId = this.client.sessionId
        const parentMetadata = this.client.getMetadata()
        if (!parentMetadata) return null
        const parentSessionId = (info.parentToolUseId && await this.childIds.get(info.parentToolUseId)) || ownerSessionId

        try {
            const session = await this.api.getOrCreateSession({
                tag: `subagent:${ownerSessionId}:${toolUseId}`,
                metadata: childSessionMetadata(parentMetadata, {
                    name: info.description ?? info.agentType ?? 'Subagent',
                    summary: undefined,
                    goal: undefined,
                    goalAvailable: undefined,
                    agentDrivers: undefined,
                    agentDriverSegments: undefined,
                    subagent: { ownerSessionId, toolUseId }
                }),
                state: null,
                parentSessionId
            })
            this.patch(toolUseId, { sessionId: session.id })
            return session.id
        } catch (error) {
            logger.debug(`[subagents] Failed to create child session for ${toolUseId}`, error)
            return null
        }
    }
}
