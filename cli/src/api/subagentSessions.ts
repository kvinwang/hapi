import type { SubagentEntry } from '@hapi/protocol/types'
import { logger } from '@/ui/logger'
import type { ApiClient } from './api'
import type { ApiSessionClient, VersionedMetadata } from './apiSession'
import { childSessionMetadata } from './childMetadata'

export type SubagentStart = {
    agentType?: string
    description?: string
    background?: boolean
    /** The spawning tool call of the subagent that spawned this one, for nested subagents. */
    parentToolUseId?: string | null
}

type ProgressUpdate = Pick<SubagentEntry, 'activity' | 'totalTokens' | 'toolUses' | 'durationMs'>

/** At most one progress write per subagent this often. */
const PROGRESS_INTERVAL_MS = 1500
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
    private readonly children = new Map<string, Promise<VersionedMetadata | null>>()
    private readonly models = new Map<string, string>()
    private readonly progressThrottle = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: ProgressUpdate | null }>()

    constructor(
        private readonly api: ApiClient,
        private readonly client: ApiSessionClient
    ) {}

    has(toolUseId: string): boolean {
        return this.children.has(toolUseId)
    }

    start(toolUseId: string, info: SubagentStart): void {
        if (this.children.has(toolUseId)) {
            // Resumed after finishing, e.g. via SendMessage.
            this.takeProgress(toolUseId)
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
        this.children.set(toolUseId, this.createChild(toolUseId, info))
    }

    /** Runs `emit` with the child session id once it exists, preserving call order per subagent. */
    send(toolUseId: string, emit: (sessionId: string) => void): void {
        if (!this.children.has(toolUseId)) {
            this.start(toolUseId, {})
        }
        void this.children.get(toolUseId)!.then((child) => {
            if (child) emit(child.sid)
        })
    }

    /** Records the model the subagent actually runs on; it may differ from the owner's. */
    model(toolUseId: string, model: string, provider: string): void {
        if (!this.children.has(toolUseId) || this.models.get(toolUseId) === model) return
        this.models.set(toolUseId, model)
        void this.children.get(toolUseId)!.then((child) => child && this.client.updateSessionMetadata(child, (metadata) => ({
            ...metadata,
            resolvedModel: model,
            resolvedModelProvider: provider,
            resolvedModelAt: Date.now()
        })))
    }

    /**
     * Progress steps are throttled per subagent (the first at once, then at most one per
     * PROGRESS_INTERVAL_MS with the latest values): each one rewrites the owner's whole metadata.
     */
    progress(toolUseId: string, update: ProgressUpdate): void {
        if (!this.children.has(toolUseId)) return
        const patch = { ...update, activity: truncate(update.activity, MAX_ACTIVITY_LENGTH) }
        const throttle = this.progressThrottle.get(toolUseId)
        if (throttle) {
            throttle.pending = { ...throttle.pending, ...patch }
            return
        }
        this.patch(toolUseId, patch)
        this.armProgressThrottle(toolUseId)
    }

    private armProgressThrottle(toolUseId: string): void {
        const timer = setTimeout(() => {
            const throttle = this.progressThrottle.get(toolUseId)
            this.progressThrottle.delete(toolUseId)
            if (throttle?.pending) {
                this.patch(toolUseId, throttle.pending)
                this.armProgressThrottle(toolUseId)
            }
        }, PROGRESS_INTERVAL_MS)
        timer.unref?.()
        this.progressThrottle.set(toolUseId, { timer, pending: null })
    }

    /** Drops a pending progress step, returning it so a final update can carry its values. */
    private takeProgress(toolUseId: string): ProgressUpdate | null {
        const throttle = this.progressThrottle.get(toolUseId)
        if (!throttle) return null
        clearTimeout(throttle.timer)
        this.progressThrottle.delete(toolUseId)
        return throttle.pending
    }

    end(toolUseId: string, result: Pick<SubagentEntry, 'status' | 'summary' | 'totalTokens' | 'toolUses' | 'durationMs'>): void {
        if (!this.children.has(toolUseId)) return
        const pending = this.takeProgress(toolUseId)
        this.patch(toolUseId, {
            ...pending,
            ...result,
            summary: truncate(result.summary, MAX_SUMMARY_LENGTH),
            activity: undefined,
            endedAt: Date.now()
        })
    }

    /** Marks subagents still running as stopped: they die with the agent process. */
    stopRunning(): void {
        for (const toolUseId of [...this.progressThrottle.keys()]) {
            this.takeProgress(toolUseId)
        }
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

    private async createChild(toolUseId: string, info: SubagentStart): Promise<VersionedMetadata | null> {
        const ownerSessionId = this.client.sessionId
        const parentMetadata = this.client.getMetadata()
        if (!parentMetadata) return null
        const parentSessionId = (info.parentToolUseId && (await this.children.get(info.parentToolUseId))?.sid) || ownerSessionId

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
            return { sid: session.id, metadata: session.metadata, version: session.metadataVersion }
        } catch (error) {
            logger.debug(`[subagents] Failed to create child session for ${toolUseId}`, error)
            return null
        }
    }
}
