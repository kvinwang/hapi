import type { EffortMode, ModelMode } from './modes'
import type { Session, WorktreeMetadata } from './schemas'

export type SessionSummaryMetadata = {
    name?: string
    path: string
    machineId?: string
    summary?: { text: string }
    flavor?: string | null
    worktree?: WorktreeMetadata
    subagent?: boolean
}

export type SessionSummary = {
    id: string
    parentSessionId?: string | null
    active: boolean
    thinking: boolean
    /** Subagents still running in the background; independent of the main agent's `thinking`. */
    runningSubagents?: number
    activeAt: number
    updatedAt: number
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    modelMode?: ModelMode
    effortMode?: EffortMode
    favorite?: boolean
    pinned?: boolean
    tags?: string[]
    totalCost?: number
}

export function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        flavor: session.metadata.flavor ?? null,
        worktree: session.metadata.worktree,
        ...(session.metadata.subagent ? { subagent: true } : {})
    } : null

    const todoProgress = session.todos?.length ? {
        completed: session.todos.filter(t => t.status === 'completed').length,
        total: session.todos.length
    } : null

    return {
        id: session.id,
        parentSessionId: session.parentSessionId ?? null,
        active: session.active,
        thinking: session.thinking,
        runningSubagents: Object.values(session.metadata?.subagents ?? {}).filter((entry) => entry.status === 'running').length,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        metadata,
        todoProgress,
        pendingRequestsCount,
        modelMode: session.modelMode,
        effortMode: session.effortMode
    }
}
