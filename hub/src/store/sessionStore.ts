import type { Database } from 'bun:sqlite'

import type { StoredSession, VersionedUpdateResult } from './types'
import {
    createSession,
    deleteSession,
    getSessionByShareToken,
    getSessionUiState,
    getOrCreateSession,
    getSession,
    getSessionByNamespace,
    getSessions,
    getSessionsByNamespace,
    getSharedSessionsByNamespace,
    setShareToken,
    setSessionTodos,
    updateSessionAgentState,
    updateSessionMetadata,
    updateSessionUiState
} from './sessions'

export class SessionStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    createSession(params: {
        tag: string
        namespace: string
        metadata: unknown
        agentState?: unknown
        todos?: unknown
    }): StoredSession {
        return createSession(this.db, params)
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): StoredSession {
        return getOrCreateSession(this.db, tag, metadata, agentState, namespace)
    }

    updateSessionMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        options?: { touchUpdatedAt?: boolean }
    ): VersionedUpdateResult<unknown | null> {
        return updateSessionMetadata(this.db, id, metadata, expectedVersion, namespace, options)
    }

    updateSessionAgentState(
        id: string,
        agentState: unknown,
        expectedVersion: number,
        namespace: string
    ): VersionedUpdateResult<unknown | null> {
        return updateSessionAgentState(this.db, id, agentState, expectedVersion, namespace)
    }

    setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, namespace: string): boolean {
        return setSessionTodos(this.db, id, todos, todosUpdatedAt, namespace)
    }

    getSession(id: string): StoredSession | null {
        return getSession(this.db, id)
    }

    getSessionByNamespace(id: string, namespace: string): StoredSession | null {
        return getSessionByNamespace(this.db, id, namespace)
    }

    getSessions(): StoredSession[] {
        return getSessions(this.db)
    }

    getSessionsByNamespace(namespace: string): StoredSession[] {
        return getSessionsByNamespace(this.db, namespace)
    }

    deleteSession(id: string, namespace: string): boolean {
        return deleteSession(this.db, id, namespace)
    }

    getSessionUiState(id: string, namespace: string): unknown | null {
        return getSessionUiState(this.db, id, namespace)
    }

    updateSessionUiState(id: string, namespace: string, uiState: unknown): boolean {
        return updateSessionUiState(this.db, id, namespace, uiState)
    }

    setShareToken(id: string, namespace: string, shareToken: string | null): boolean {
        return setShareToken(this.db, id, namespace, shareToken)
    }

    getSessionByShareToken(shareToken: string): StoredSession | null {
        return getSessionByShareToken(this.db, shareToken)
    }

    getSharedSessionsByNamespace(namespace: string): StoredSession[] {
        return getSharedSessionsByNamespace(this.db, namespace)
    }
}
