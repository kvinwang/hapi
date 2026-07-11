import { isObject, toSessionSummary } from '@hapi/protocol'
import type { Session, SessionResponse, SessionsResponse, SessionSummary } from '@/types/api'

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key)
}

function isSessionRecord(value: unknown): value is Session {
    return isObject(value)
        && typeof value.id === 'string'
        && typeof value.namespace === 'string'
        && typeof value.createdAt === 'number'
        && typeof value.updatedAt === 'number'
        && typeof value.active === 'boolean'
        && typeof value.activeAt === 'number'
        && typeof value.seq === 'number'
        && typeof value.metadataVersion === 'number'
        && typeof value.agentStateVersion === 'number'
        && typeof value.thinking === 'boolean'
        && typeof value.thinkingAt === 'number'
}

function mergeSessionSummary(current: SessionSummary, patch: Partial<Session>): SessionSummary {
    const next: SessionSummary = { ...current }

    if (hasOwn(patch, 'parentSessionId')) {
        next.parentSessionId = patch.parentSessionId ?? null
    }
    if (typeof patch.active === 'boolean') {
        next.active = patch.active
    }
    if (typeof patch.thinking === 'boolean') {
        next.thinking = patch.thinking
    }
    if (typeof patch.activeAt === 'number') {
        next.activeAt = patch.activeAt
    }
    if (typeof patch.updatedAt === 'number') {
        next.updatedAt = patch.updatedAt
    }
    if (hasOwn(patch, 'modelMode')) {
        next.modelMode = patch.modelMode
    }
    if (hasOwn(patch, 'effortMode')) {
        next.effortMode = patch.effortMode
    }

    if (hasOwn(patch, 'metadata')) {
        if (!patch.metadata) {
            next.metadata = null
        } else {
            next.metadata = {
                path: patch.metadata.path,
                name: patch.metadata.name,
                machineId: patch.metadata.machineId ?? undefined,
                summary: patch.metadata.summary ? { text: patch.metadata.summary.text } : undefined,
                flavor: patch.metadata.flavor ?? null,
                worktree: patch.metadata.worktree
            }
        }
    }

    if (hasOwn(patch, 'agentState')) {
        next.pendingRequestsCount = patch.agentState?.requests
            ? Object.keys(patch.agentState.requests).length
            : 0
    }

    if (hasOwn(patch, 'todos')) {
        next.todoProgress = patch.todos && patch.todos.length > 0
            ? {
                completed: patch.todos.filter((todo) => todo.status === 'completed').length,
                total: patch.todos.length
            }
            : null
    }

    return next
}

export function mergeSessionResponse(
    current: SessionResponse | undefined,
    patch: unknown
): SessionResponse | undefined {
    if (isSessionRecord(patch)) {
        return { session: patch }
    }

    if (!current || !isObject(patch)) {
        return current
    }

    return {
        session: {
            ...current.session,
            ...(patch as Partial<Session>)
        }
    }
}

export function mergeSessionsResponse(
    current: SessionsResponse | undefined,
    sessionId: string,
    patch: unknown,
    options?: { addIfMissing?: boolean }
): SessionsResponse | undefined {
    if (!current) {
        if (options?.addIfMissing && isSessionRecord(patch)) {
            return { sessions: [toSessionSummary(patch)] }
        }
        return current
    }

    if (!isObject(patch)) {
        return current
    }

    const nextSummary = isSessionRecord(patch)
        ? toSessionSummary(patch)
        : null

    let found = false
    const sessions = current.sessions.map((session) => {
        if (session.id !== sessionId) {
            return session
        }
        found = true
        return nextSummary ?? mergeSessionSummary(session, patch as Partial<Session>)
    })

    if (!found && options?.addIfMissing && nextSummary) {
        sessions.push(nextSummary)
    }

    return found || (options?.addIfMissing && nextSummary)
        ? { sessions }
        : current
}
