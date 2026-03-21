import { randomUUID } from 'node:crypto'
import { existsSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isModelModeAllowedForFlavor, isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import { AgentStateSchema, MetadataSchema } from '@hapi/protocol/schemas'
import type { AgentFlavor, Metadata, ModelMode, PermissionMode, Session } from '@hapi/protocol/types'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from './todos'

export class SessionCache {
    private readonly sessions: Map<string, Session> = new Map()
    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()

    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher,
        private readonly filesDir?: string
    ) {
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.getSessions().filter((session) => session.namespace === namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessions.get(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    getDirectChildSessions(sessionId: string, namespace: string): Session[] {
        return this.getSessionsByNamespace(namespace)
            .filter((session) => session.parentSessionId === sessionId)
    }

    getDescendantSessions(sessionId: string, namespace: string): Session[] {
        const descendants: Session[] = []
        const queue = [...this.getDirectChildSessions(sessionId, namespace)]
        const seen = new Set<string>()

        while (queue.length > 0) {
            const current = queue.shift()
            if (!current || seen.has(current.id)) {
                continue
            }
            seen.add(current.id)
            descendants.push(current)
            queue.push(...this.getDirectChildSessions(current.id, namespace))
        }

        return descendants
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (session) {
            if (session.namespace !== namespace) {
                return { ok: false, reason: 'access-denied' }
            }
            return { ok: true, sessionId, session }
        }

        return { ok: false, reason: 'not-found' }
    }

    getActiveSessions(): Session[] {
        return this.getSessions().filter((session) => session.active)
    }

    getSessionTag(sessionId: string): string | null {
        const stored = this.store.sessions.getSession(sessionId)
        return stored?.tag ?? null
    }

    getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        parentSessionId?: string | null
    ): Session {
        const stored = this.store.sessions.getOrCreateSession(tag, metadata, agentState, namespace, parentSessionId)
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    createSession(
        tag: string,
        metadata: unknown,
        namespace: string,
        options?: {
            parentSessionId?: string | null
            agentState?: unknown
            todos?: unknown
        }
    ): Session {
        const stored = this.store.sessions.createSession({
            tag,
            parentSessionId: options?.parentSessionId,
            namespace,
            metadata,
            agentState: options?.agentState,
            todos: options?.todos
        })
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    refreshSession(sessionId: string): Session | null {
        let stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        if (stored.todos === null && !this.todoBackfillAttemptedSessionIds.has(sessionId)) {
            this.todoBackfillAttemptedSessionIds.add(sessionId)
            const messages = this.store.messages.getMessages(sessionId, 200)
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const message = messages[i]
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (todos) {
                    const updated = this.store.sessions.setSessionTodos(sessionId, todos, message.createdAt, stored.namespace)
                    if (updated) {
                        stored = this.store.sessions.getSession(sessionId) ?? stored
                    }
                    break
                }
            }
        }

        const metadata = (() => {
            const parsed = MetadataSchema.safeParse(stored.metadata)
            return parsed.success ? parsed.data : null
        })()

        const agentState = (() => {
            const parsed = AgentStateSchema.safeParse(stored.agentState)
            return parsed.success ? parsed.data : null
        })()

        const todos = (() => {
            if (stored.todos === null) return undefined
            const parsed = TodosSchema.safeParse(stored.todos)
            return parsed.success ? parsed.data : undefined
        })()

        const session: Session = {
            id: stored.id,
            parentSessionId: stored.parentSessionId,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: existing?.active ?? stored.active,
            activeAt: existing?.activeAt ?? (stored.activeAt ?? stored.createdAt),
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? false,
            thinkingAt: existing?.thinkingAt ?? 0,
            todos,
            permissionMode: existing?.permissionMode,
            modelMode: existing?.modelMode
        }

        this.sessions.set(sessionId, session)
        this.publisher.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    reloadAll(): void {
        const sessions = this.store.sessions.getSessions()
        for (const session of sessions) {
            this.refreshSession(session.id)
        }
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        modelMode?: ModelMode
    }): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousPermissionMode = session.permissionMode
        const previousModelMode = session.modelMode

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        session.thinking = Boolean(payload.thinking)
        session.thinkingAt = t
        if (payload.permissionMode !== undefined) {
            session.permissionMode = payload.permissionMode
        }
        if (payload.modelMode !== undefined) {
            session.modelMode = payload.modelMode
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const modeChanged = previousPermissionMode !== session.permissionMode || previousModelMode !== session.modelMode
        if (modeChanged) {
            this.persistModesToMetadata(session)
        }
        const shouldBroadcast = (!wasActive && session.active)
            || (wasThinking !== session.thinking)
            || modeChanged
            || (now - lastBroadcastAt > 10_000)

        if (shouldBroadcast) {
            this.lastBroadcastAtBySessionId.set(session.id, now)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    permissionMode: session.permissionMode,
                    modelMode: session.modelMode
                }
            })
        }
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        const t = clampAliveTime(payload.time) ?? Date.now()

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        if (!session.active && !session.thinking) {
            return
        }

        session.active = false
        session.thinking = false
        session.thinkingAt = t

        this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false, thinking: false } })
    }

    expireInactive(now: number = Date.now()): void {
        const sessionTimeoutMs = 30_000

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            session.thinking = false
            this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false } })
        }
    }

    applySessionConfig(sessionId: string, config: { permissionMode?: PermissionMode; modelMode?: ModelMode }): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) {
            return
        }

        if (config.permissionMode !== undefined) {
            session.permissionMode = config.permissionMode
        }
        if (config.modelMode !== undefined) {
            session.modelMode = config.modelMode
        }

        this.persistModesToMetadata(session)
        this.publisher.emit({ type: 'session-updated', sessionId, data: session })
    }

    private persistModesToMetadata(session: Session): void {
        const currentMetadata = session.metadata ?? { path: '', host: '' }
        if (currentMetadata.permissionMode === session.permissionMode && currentMetadata.modelMode === session.modelMode) {
            return
        }
        const newMetadata = { ...currentMetadata, permissionMode: session.permissionMode, modelMode: session.modelMode }
        this.store.sessions.updateSessionMetadata(
            session.id,
            newMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )
        this.refreshSession(session.id)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        const currentMetadata = session.metadata ?? { path: '', host: '' }
        const newMetadata = { ...currentMetadata, name }

        const result = this.store.sessions.updateSessionMetadata(
            sessionId,
            newMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            throw new Error('Failed to update session metadata')
        }

        if (result.result === 'version-mismatch') {
            throw new Error('Session was modified concurrently. Please try again.')
        }

        this.refreshSession(sessionId)
    }

    async deleteSession(
        sessionId: string,
        options?: { mode?: 'single' | 'detach-children' | 'recursive' }
    ): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }
        const mode = options?.mode ?? 'single'
        const directChildren = this.getDirectChildSessions(sessionId, session.namespace)

        if (mode === 'single' && directChildren.length > 0) {
            throw new Error('Session has child sessions. Choose delete-only or recursive delete.')
        }

        if (mode === 'recursive') {
            const targets = [...this.getDescendantSessions(sessionId, session.namespace), session]
            this.assertSessionsDeletable(targets)
            for (const target of targets.sort((a, b) => b.createdAt - a.createdAt)) {
                this.deleteSessionRecord(target.id, target.namespace)
            }
            return
        }

        this.assertSessionsDeletable([session])

        if (mode === 'detach-children') {
            for (const child of directChildren) {
                this.store.sessions.updateSessionParent(child.id, null, session.namespace)
                this.refreshSession(child.id)
            }
        }

        this.deleteSessionRecord(sessionId, session.namespace)
    }

    forkSession(
        sourceSessionId: string,
        messageSeq: number,
        namespace: string,
        options?: { targetFlavor?: AgentFlavor }
    ): { sessionId: string; metadata: Metadata; forkAtTimestamp?: string; sourceAgentSessionId?: string } {
        const access = this.resolveSessionAccess(sourceSessionId, namespace)
        if (!access.ok) {
            throw new Error(access.reason === 'access-denied' ? 'Session access denied' : 'Session not found')
        }

        const source = access.session
        const sourceMetadata = source.metadata ?? { path: '', host: '' }
        const sourceFlavor = this.normalizeFlavor(sourceMetadata.flavor)
        const targetFlavor = options?.targetFlavor ?? sourceFlavor

        const forkedMetadata: Metadata = {
            ...sourceMetadata,
            name: sourceMetadata.name
                ? `${sourceMetadata.name} (${targetFlavor === sourceFlavor ? 'fork' : targetFlavor})`
                : undefined,
            flavor: targetFlavor,
            claudeSessionId: undefined,
            codexSessionId: undefined,
            geminiSessionId: undefined,
            opencodeSessionId: undefined,
            hostPid: undefined,
            lifecycleState: undefined,
            lifecycleStateSince: undefined,
            archivedBy: undefined,
            archiveReason: undefined,
            startedFromRunner: undefined,
            startedBy: undefined
        }
        if (forkedMetadata.permissionMode && !isPermissionModeAllowedForFlavor(forkedMetadata.permissionMode, targetFlavor)) {
            forkedMetadata.permissionMode = undefined
        }
        if (forkedMetadata.modelMode && !isModelModeAllowedForFlavor(forkedMetadata.modelMode, targetFlavor)) {
            forkedMetadata.modelMode = undefined
        }

        const stored = this.store.sessions.createSession({
            tag: `fork-${randomUUID()}`,
            parentSessionId: sourceSessionId,
            namespace,
            metadata: forkedMetadata,
            agentState: null
        })

        this.store.messages.copyMessagesToSession(sourceSessionId, stored.id, messageSeq)

        // Copy uploaded files from source session
        if (this.filesDir) {
            const srcDir = join(this.filesDir, sourceSessionId)
            if (existsSync(srcDir)) {
                cpSync(srcDir, join(this.filesDir, stored.id), { recursive: true })
            }
        }

        // Copy prompt-related uiState from source session
        const sourceUiState = this.store.sessions.getSessionUiState(sourceSessionId, namespace)
        if (sourceUiState && typeof sourceUiState === 'object') {
            const src = sourceUiState as Record<string, unknown>
            const promptState: Record<string, unknown> = {}
            if (typeof src.systemPrompt === 'string' && src.systemPrompt) promptState.systemPrompt = src.systemPrompt
            if (typeof src.useGlobalPrompt === 'boolean') promptState.useGlobalPrompt = src.useGlobalPrompt
            if (Object.keys(promptState).length > 0) {
                this.store.sessions.updateSessionUiState(stored.id, namespace, promptState)
            }
        }

        // Extract timestamp from the last message at or before fork point for JSONL truncation
        const forkAtTimestamp = this.extractForkTimestamp(sourceSessionId, messageSeq)
        const sourceAgentSessionId = targetFlavor === sourceFlavor
            ? targetFlavor === 'codex'
                ? sourceMetadata.codexSessionId
                : targetFlavor === 'claude'
                    ? sourceMetadata.claudeSessionId
                    : undefined
            : undefined

        const session = this.refreshSession(stored.id)
        if (!session) {
            throw new Error('Failed to load forked session')
        }

        return { sessionId: stored.id, metadata: forkedMetadata, forkAtTimestamp, sourceAgentSessionId }
    }

    private extractForkTimestamp(sessionId: string, messageSeq: number): string | undefined {
        // Scan backwards from messageSeq to find a message with a timestamp in content.data
        const messages = this.store.messages.getMessagesUpToSeq(sessionId, messageSeq, 50)
        for (let i = messages.length - 1; i >= 0; i--) {
            const content = messages[i].content as any
            const timestamp = content?.content?.data?.timestamp
            if (typeof timestamp === 'string') {
                return timestamp
            }
        }
        // Fallback: use createdAt from the message at fork point (covers Codex and other flavors
        // whose messages don't carry an embedded timestamp)
        if (messages.length > 0) {
            const lastMsg = messages[messages.length - 1]
            return new Date(lastMsg.createdAt).toISOString()
        }
        return undefined
    }

    private normalizeFlavor(flavor: string | null | undefined): AgentFlavor {
        if (flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode') {
            return flavor
        }
        return 'claude'
    }

    async mergeSessions(oldSessionId: string, newSessionId: string, namespace: string): Promise<void> {
        if (oldSessionId === newSessionId) {
            return
        }

        const oldStored = this.store.sessions.getSessionByNamespace(oldSessionId, namespace)
        const newStored = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
        if (!oldStored || !newStored) {
            throw new Error('Session not found for merge')
        }

        this.store.messages.mergeSessionMessages(oldSessionId, newSessionId)

        const mergedMetadata = this.mergeSessionMetadata(oldStored.metadata, newStored.metadata)
        if (mergedMetadata !== null && mergedMetadata !== newStored.metadata) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                if (!latest) break
                const result = this.store.sessions.updateSessionMetadata(
                    newSessionId,
                    mergedMetadata,
                    latest.metadataVersion,
                    namespace,
                    { touchUpdatedAt: false }
                )
                if (result.result === 'success') {
                    break
                }
                if (result.result === 'error') {
                    break
                }
            }
        }

        if (oldStored.todos !== null && oldStored.todosUpdatedAt !== null) {
            this.store.sessions.setSessionTodos(
                newSessionId,
                oldStored.todos,
                oldStored.todosUpdatedAt,
                namespace
            )
        }

        if (oldStored.parentSessionId && !newStored.parentSessionId) {
            this.store.sessions.updateSessionParent(newSessionId, oldStored.parentSessionId, namespace)
        }

        const deleted = this.store.sessions.deleteSession(oldSessionId, namespace)
        if (!deleted) {
            throw new Error('Failed to delete old session during merge')
        }

        // Merge uploaded files from old session into new session
        if (this.filesDir) {
            const oldDir = join(this.filesDir, oldSessionId)
            if (existsSync(oldDir)) {
                const newDir = join(this.filesDir, newSessionId)
                mkdirSync(newDir, { recursive: true })
                cpSync(oldDir, newDir, { recursive: true })
                rmSync(oldDir, { recursive: true, force: true })
            }
        }

        const existed = this.sessions.delete(oldSessionId)
        if (existed) {
            this.publisher.emit({ type: 'session-removed', sessionId: oldSessionId, namespace })
        }
        this.lastBroadcastAtBySessionId.delete(oldSessionId)
        this.todoBackfillAttemptedSessionIds.delete(oldSessionId)

        this.refreshSession(newSessionId)
    }

    getSessionUiState(sessionId: string, namespace: string): unknown | null {
        return this.store.sessions.getSessionUiState(sessionId, namespace)
    }

    updateSessionUiState(sessionId: string, namespace: string, uiState: unknown): boolean {
        const ok = this.store.sessions.updateSessionUiState(sessionId, namespace, uiState)
        if (ok) {
            this.publisher.emit({ type: 'session-updated', sessionId, data: { uiState } })
        }
        return ok
    }

    private assertSessionsDeletable(sessions: Session[]): void {
        const active = sessions.find((session) => session.active)
        if (active) {
            throw new Error(`Cannot delete active session: ${active.id}`)
        }

        for (const session of sessions) {
            const storedSession = this.store.sessions.getSessionByNamespace(session.id, session.namespace)
            if (storedSession?.shareToken) {
                throw new Error(`Cannot delete shared session ${session.id}. Unshare it first.`)
            }
        }
    }

    private deleteSessionRecord(sessionId: string, namespace: string): void {
        const deleted = this.store.sessions.deleteSession(sessionId, namespace)
        if (!deleted) {
            throw new Error('Failed to delete session')
        }

        if (this.filesDir) {
            rmSync(join(this.filesDir, sessionId), { recursive: true, force: true })
        }

        this.sessions.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)

        this.publisher.emit({ type: 'session-removed', sessionId, namespace })
    }

    private mergeSessionMetadata(oldMetadata: unknown | null, newMetadata: unknown | null): unknown | null {
        if (!oldMetadata || typeof oldMetadata !== 'object') {
            return newMetadata
        }
        if (!newMetadata || typeof newMetadata !== 'object') {
            return oldMetadata
        }

        const oldObj = oldMetadata as Record<string, unknown>
        const newObj = newMetadata as Record<string, unknown>
        const merged: Record<string, unknown> = { ...newObj }
        let changed = false

        if (typeof oldObj.name === 'string' && typeof newObj.name !== 'string') {
            merged.name = oldObj.name
            changed = true
        }

        const oldSummary = oldObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const newSummary = newObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const oldUpdatedAt = typeof oldSummary?.updatedAt === 'number' ? oldSummary.updatedAt : null
        const newUpdatedAt = typeof newSummary?.updatedAt === 'number' ? newSummary.updatedAt : null
        if (oldUpdatedAt !== null && (newUpdatedAt === null || oldUpdatedAt > newUpdatedAt)) {
            merged.summary = oldSummary
            changed = true
        }

        if (oldObj.worktree && !newObj.worktree) {
            merged.worktree = oldObj.worktree
            changed = true
        }

        if (typeof oldObj.path === 'string' && typeof newObj.path !== 'string') {
            merged.path = oldObj.path
            changed = true
        }
        if (typeof oldObj.host === 'string' && typeof newObj.host !== 'string') {
            merged.host = oldObj.host
            changed = true
        }

        return changed ? merged : newMetadata
    }
}
