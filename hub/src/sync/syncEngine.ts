/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { buildMessageAppendSystemPrompt } from '@hapi/protocol/prompts'
import type { AgentFlavor, DecryptedMessage, Metadata, ModelMode, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService, type SessionHistoryOptions, type SessionHistoryResult, type SessionHistoryRole } from './messageService'
import {
    RpcGateway,
    type RpcApplyCredentialsResponse,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcListDirectoryResponse,
    type RpcPathExistsResponse,
    type RpcImportSshKeyResponse,
    type RpcReadCredentialsResponse,
    type RpcReadFileResponse,
    type RpcSessionDebugStateResponse,
    type RpcUploadFileResponse
} from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcApplyCredentialsResponse,
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcImportSshKeyResponse,
    RpcListDirectoryResponse,
    RpcPathExistsResponse,
    RpcReadCredentialsResponse,
    RpcReadFileResponse,
    RpcSessionDebugStateResponse,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

export type ForkSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'fork_failed' | 'fork_not_ready' }

export type ConvertSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'already_target_flavor' | 'convert_failed' }

export class SyncEngine {
    private readonly store: Store
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly machineCache: MachineCache
    private readonly messageService: MessageService
    private readonly rpcGateway: RpcGateway
    private inactivityTimer: NodeJS.Timeout | null = null

    constructor(
        store: Store,
        io: Server,
        rpcRegistry: RpcRegistry,
        sseManager: SSEManager,
        filesDir?: string
    ) {
        this.store = store
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher, filesDir)
        this.machineCache = new MachineCache(store, this.eventPublisher)
        this.messageService = new MessageService(store, io, this.eventPublisher)
        this.rpcGateway = new RpcGateway(io, rpcRegistry)
        this.reloadAll()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    stop(): void {
        if (this.inactivityTimer) {
            clearInterval(this.inactivityTimer)
            this.inactivityTimer = null
        }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) {
            return event.namespace
        }
        if ('sessionId' in event) {
            return this.getSession(event.sessionId)?.namespace
        }
        if ('machineId' in event) {
            return this.machineCache.getMachine(event.machineId)?.namespace
        }
        return undefined
    }

    getSessions(): Session[] {
        return this.sessionCache.getSessions()
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.sessionCache.getSessionsByNamespace(namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessionCache.getSession(sessionId) ?? this.sessionCache.refreshSession(sessionId) ?? undefined
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    getDirectChildSessions(sessionId: string, namespace: string): Session[] {
        return this.sessionCache.getDirectChildSessions(sessionId, namespace)
    }

    getDescendantSessions(sessionId: string, namespace: string): Session[] {
        return this.sessionCache.getDescendantSessions(sessionId, namespace)
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        return this.sessionCache.resolveSessionAccess(sessionId, namespace)
    }

    getActiveSessions(): Session[] {
        return this.sessionCache.getActiveSessions()
    }

    getMachines(): Machine[] {
        return this.machineCache.getMachines()
    }

    getMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getMachinesByNamespace(namespace)
    }

    getMachine(machineId: string): Machine | undefined {
        return this.machineCache.getMachine(machineId)
    }

    getMachineByNamespace(machineId: string, namespace: string): Machine | undefined {
        return this.machineCache.getMachineByNamespace(machineId, namespace)
    }

    getOnlineMachines(): Machine[] {
        return this.machineCache.getOnlineMachines()
    }

    getOnlineMachinesByNamespace(namespace: string): Machine[] {
        return this.machineCache.getOnlineMachinesByNamespace(namespace)
    }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null; afterSeq: number | null; role?: SessionHistoryRole }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            afterSeq: number | null
            nextAfterSeq: number | null
            hasMore: boolean
        }
    } {
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
    }

    getLatestMessageSeq(sessionId: string): number {
        return this.messageService.getLatestMessageSeq(sessionId)
    }

    getSessionHistory(sessionId: string, options: SessionHistoryOptions): SessionHistoryResult {
        return this.messageService.getSessionHistory(sessionId, options)
    }

    trimMessages(
        sessionId: string,
        options: { mode: 'before' | 'after' | 'single'; seq: number }
    ): { deleted: number } {
        return this.messageService.trimMessages(sessionId, options)
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            this.sessionCache.refreshSession(event.sessionId)
            return
        }

        if (event.type === 'machine-updated' && event.machineId) {
            this.machineCache.refreshMachine(event.machineId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (!this.getSession(event.sessionId)) {
                this.sessionCache.refreshSession(event.sessionId)
            }
        }

        this.eventPublisher.emit(event)
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        modelMode?: ModelMode
    }): void {
        this.sessionCache.handleSessionAlive(payload)
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        this.sessionCache.handleSessionEnd(payload)
    }

    forceSessionIdle(sessionId: string, options?: { active?: boolean; time?: number }): void {
        this.sessionCache.forceIdle(sessionId, options)
    }

    handleMachineAlive(payload: { machineId: string; time: number }): void {
        this.machineCache.handleMachineAlive(payload)
    }

    private expireInactive(): void {
        this.sessionCache.expireInactive()
        this.machineCache.expireInactive()
    }

    private reloadAll(): void {
        this.sessionCache.reloadAll()
        this.machineCache.reloadAll()
    }

    getOrCreateSession(
        tag: string,
        metadata: unknown,
        agentState: unknown,
        namespace: string,
        parentSessionId?: string | null
    ): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace, parentSessionId)
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
        return this.sessionCache.createSession(tag, metadata, namespace, options)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string, apiKeyId: string | null = null): Machine {
        return this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace, apiKeyId)
    }

    refreshMachine(machineId: string): Machine | null {
        return this.machineCache.refreshMachine(machineId)
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: Array<{
                id: string
                filename: string
                mimeType: string
                size: number
                path: string
                previewUrl?: string
            }>
            sentFrom?: 'telegram-bot' | 'webapp' | 'lobstear' | 'cli'
        }
    ): Promise<{ seq: number }> {
        // Read session/global prompt from DB, then append shared HAPI prompt
        const session = this.sessionCache.getSession(sessionId)
        let systemPrompt: string | undefined
        if (session) {
            const uiState = this.sessionCache.getSessionUiState(sessionId, session.namespace)
            let sessionSp: string | undefined
            let includeGlobal = false
            if (uiState && typeof uiState === 'object') {
                const state = uiState as Record<string, unknown>
                const sp = state.systemPrompt
                if (typeof sp === 'string' && sp) sessionSp = sp
                includeGlobal = state.useGlobalPrompt !== false
            }
            const globalSp = this.store.preferences.get(session.namespace, 'systemPrompt')
            systemPrompt = buildMessageAppendSystemPrompt({
                globalPrompt: globalSp,
                sessionPrompt: sessionSp,
                includeGlobal
            })
        }

        return await this.messageService.sendMessage(sessionId, {
            ...payload,
            systemPrompt
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.rpcGateway.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.rpcGateway.denyPermission(sessionId, requestId, decision)
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.rpcGateway.abortSession(sessionId)
    }

    async interruptSession(sessionId: string): Promise<void> {
        await this.rpcGateway.interruptSession(sessionId)
    }

    async archiveSession(sessionId: string): Promise<void> {
        const session = this.getSession(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        const targets = [...this.getDescendantSessions(sessionId, session.namespace), session]
        for (const target of targets) {
            if (!target.active) {
                continue
            }
            await this.rpcGateway.killSession(target.id)
            this.handleSessionEnd({ sid: target.id, time: Date.now() })
        }
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    reparentSession(sessionId: string, parentSessionId: string | null): void {
        this.sessionCache.reparentSession(sessionId, parentSessionId)
    }

    async deleteSession(
        sessionId: string,
        options?: { mode?: 'single' | 'detach-children' | 'recursive' }
    ): Promise<void> {
        await this.sessionCache.deleteSession(sessionId, options)
    }

    updateMachineNotes(machineId: string, notes: string | null): Machine | null {
        return this.machineCache.updateMachineNotes(machineId, notes)
    }

    deleteMachine(machineId: string): void {
        this.machineCache.deleteMachine(machineId)
    }

    async applySessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            modelMode?: ModelMode
        }
    ): Promise<void> {
        const result = await this.rpcGateway.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') {
            throw new Error('Invalid response from session config RPC')
        }
        const obj = result as { applied?: { permissionMode?: Session['permissionMode']; modelMode?: Session['modelMode'] } }
        const applied = obj.applied
        if (!applied || typeof applied !== 'object') {
            throw new Error('Missing applied session config')
        }

        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    private async restoreSessionModes(sessionId: string, sourceMetadata: { permissionMode?: PermissionMode; modelMode?: ModelMode }): Promise<void> {
        const config: { permissionMode?: PermissionMode; modelMode?: ModelMode } = {}
        if (sourceMetadata.permissionMode) config.permissionMode = sourceMetadata.permissionMode
        if (sourceMetadata.modelMode) config.modelMode = sourceMetadata.modelMode
        if (config.permissionMode || config.modelMode) {
            try {
                await this.applySessionConfig(sessionId, config)
            } catch {
                // Best-effort: don't fail resume/fork if mode restoration fails
            }
        }
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' = 'claude',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        parentSessionId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        const spawnedAt = Date.now()
        const parentMetadata = parentSessionId ? this.getSession(parentSessionId)?.metadata ?? null : null
        const inheritedYolo = parentMetadata?.permissionMode === 'bypassPermissions'
            || parentMetadata?.permissionMode === 'yolo'
            || parentMetadata?.permissionMode === 'safe-yolo'
        const effectiveYolo = yolo ?? (inheritedYolo || undefined)
        const result = await this.rpcGateway.spawnSession(machineId, directory, agent, model, effectiveYolo, sessionType, worktreeName, resumeSessionId, undefined, undefined, undefined, parentSessionId)

        if (result.type === 'success') {
            const session = this.getSession(result.sessionId)
            if (session && session.createdAt < spawnedAt - 30_000) {
                const ageSeconds = Math.round((spawnedAt - session.createdAt) / 1000)
                return { type: 'error', message: `Spawn returned a stale session (created ${ageSeconds}s ago, id: ${result.sessionId}). This may indicate orphaned CLI processes — try stopping them and retrying.` }
            }

            const inheritedConfig: { permissionMode?: PermissionMode; modelMode?: ModelMode } = {}
            if (parentMetadata && yolo === undefined && parentMetadata.permissionMode) {
                inheritedConfig.permissionMode = parentMetadata.permissionMode
            }
            if (parentMetadata && model === undefined && parentMetadata.modelMode) {
                inheritedConfig.modelMode = parentMetadata.modelMode
            }
            if (inheritedConfig.permissionMode || inheritedConfig.modelMode) {
                const becameActive = await this.waitForSessionActive(result.sessionId)
                if (becameActive) {
                    try {
                        await this.applySessionConfig(result.sessionId, inheritedConfig)
                    } catch {
                        // Best-effort: don't fail spawn if inherited mode restoration fails
                    }
                }
            }
        }

        return result
    }

    async resumeSession(sessionId: string, namespace: string): Promise<ResumeSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const session = access.session
        if (session.active) {
            return { type: 'success', sessionId: access.sessionId }
        }

        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string') {
            return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        }

        const flavor = metadata.flavor === 'codex' || metadata.flavor === 'gemini' || metadata.flavor === 'opencode' || metadata.flavor === 'cursor'
            ? metadata.flavor
            : 'claude'
        const resumeToken = flavor === 'codex'
            ? metadata.codexSessionId
            : flavor === 'gemini'
                ? metadata.geminiSessionId
                : flavor === 'opencode'
                    ? metadata.opencodeSessionId
                    : flavor === 'cursor'
                        ? metadata.cursorSessionId
                        : metadata.claudeSessionId

        if (!resumeToken) {
            return { type: 'error', message: 'Resume session ID unavailable', code: 'resume_unavailable' }
        }

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const targetMachine = (() => {
            if (metadata.machineId) {
                const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
                if (exact) return exact
            }
            if (metadata.host) {
                const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
                if (hostMatch) return hostMatch
            }
            return null
        })()

        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const sessionTag = this.sessionCache.getSessionTag(access.sessionId)

        const isYolo = metadata.permissionMode === 'bypassPermissions'
            || metadata.permissionMode === 'yolo'
            || metadata.permissionMode === 'safe-yolo'

        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            metadata.path,
            flavor,
            undefined,
            isYolo || undefined,
            undefined,
            undefined,
            resumeToken ?? undefined,
            undefined,
            undefined,
            sessionTag ?? undefined
        )

        if (spawnResult.type !== 'success') {
            return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
        }

        await this.restoreSessionModes(spawnResult.sessionId, metadata)

        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    async waitForSessionActive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const session = this.getSession(sessionId)
            if (session?.active) {
                return true
            }
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async forkSession(
        sessionId: string,
        messageSeq: number,
        namespace: string,
        targetFlavor?: AgentFlavor
    ): Promise<ForkSessionResult> {
        let forked: { sessionId: string; metadata: Metadata; forkAtTimestamp?: string; sourceAgentSessionId?: string }
        try {
            forked = this.sessionCache.forkSession(sessionId, messageSeq, namespace, { targetFlavor })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Fork failed'
            if (message.includes('access denied')) {
                return { type: 'error', message, code: 'access_denied' }
            }
            if (message.includes('not found')) {
                return { type: 'error', message, code: 'session_not_found' }
            }
            return { type: 'error', message, code: 'fork_failed' }
        }

        const { metadata } = forked

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const targetMachine = (() => {
            if (metadata.machineId) {
                const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
                if (exact) return exact
            }
            if (metadata.host) {
                const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
                if (hostMatch) return hostMatch
            }
            return null
        })()

        if (!targetMachine) {
            return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
        }

        const flavor = metadata.flavor === 'codex' || metadata.flavor === 'gemini' || metadata.flavor === 'opencode'
            ? metadata.flavor
            : 'claude' as const

        const wantsJsonlFork = flavor === 'claude' || flavor === 'codex'

        // Agent session ID is required for Claude/Codex forks to copy JSONL history.
        // If not yet available (e.g. source session's agent hook hasn't fired), fail early
        // so the user can retry rather than silently starting without history.
        if (wantsJsonlFork && forked.forkAtTimestamp && !forked.sourceAgentSessionId) {
            await this.sessionCache.deleteSession(forked.sessionId)
            return { type: 'error', message: 'Source session agent not ready yet, please try again later', code: 'fork_not_ready' }
        }

        const isYolo = metadata.permissionMode === 'bypassPermissions'
            || metadata.permissionMode === 'yolo'
            || metadata.permissionMode === 'safe-yolo'

        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            metadata.path,
            flavor,
            undefined,
            isYolo || undefined,
            undefined,
            undefined,
            undefined,
            wantsJsonlFork ? forked.sourceAgentSessionId : undefined,
            wantsJsonlFork ? forked.forkAtTimestamp : undefined,
            this.sessionCache.getSessionTag(forked.sessionId) ?? undefined
        )

        if (spawnResult.type !== 'success') {
            return { type: 'error', message: spawnResult.message, code: 'fork_failed' }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return { type: 'error', message: 'Session failed to become active', code: 'fork_failed' }
        }

        if (spawnResult.sessionId !== forked.sessionId) {
            try {
                await this.sessionCache.mergeSessions(forked.sessionId, spawnResult.sessionId, namespace)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to merge forked session'
                return { type: 'error', message, code: 'fork_failed' }
            }
        }

        await this.restoreSessionModes(spawnResult.sessionId, forked.metadata)

        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    async convertSession(sessionId: string, targetFlavor: 'claude' | 'codex', namespace: string): Promise<ConvertSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return {
                type: 'error',
                message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found',
                code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found'
            }
        }

        const sourceFlavor = access.session.metadata?.flavor === 'codex' ? 'codex' : 'claude'
        if (sourceFlavor === targetFlavor) {
            return {
                type: 'error',
                message: `Session already uses ${targetFlavor}`,
                code: 'already_target_flavor'
            }
        }

        const metadata = access.session.metadata
        if (!metadata?.path) {
            return {
                type: 'error',
                message: 'Source session has no workspace path',
                code: 'convert_failed'
            }
        }

        const onlineMachines = this.machineCache.getOnlineMachinesByNamespace(namespace)
        if (onlineMachines.length === 0) {
            return {
                type: 'error',
                message: 'No machine online',
                code: 'no_machine_online'
            }
        }

        const targetMachine = (() => {
            if (metadata.machineId) {
                const exact = onlineMachines.find((machine) => machine.id === metadata.machineId)
                if (exact) return exact
            }
            if (metadata.host) {
                const hostMatch = onlineMachines.find((machine) => machine.metadata?.host === metadata.host)
                if (hostMatch) return hostMatch
            }
            return null
        })()

        if (!targetMachine) {
            return {
                type: 'error',
                message: 'No machine online',
                code: 'no_machine_online'
            }
        }

        const isYolo = metadata.permissionMode === 'bypassPermissions'
            || metadata.permissionMode === 'yolo'
            || metadata.permissionMode === 'safe-yolo'

        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            metadata.path,
            targetFlavor,
            undefined,
            isYolo || undefined
        )
        if (spawnResult.type !== 'success') {
            return {
                type: 'error',
                message: spawnResult.message,
                code: 'convert_failed'
            }
        }

        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) {
            return {
                type: 'error',
                message: 'Session failed to become active',
                code: 'convert_failed'
            }
        }

        try {
            await this.restoreSessionModes(spawnResult.sessionId, metadata)
        } catch {
            // Best-effort mode restore; keep conversion flow running
        }

        const bootstrapPrompt = this.buildContinueWithPrompt(sessionId)
        try {
            await this.sendMessage(spawnResult.sessionId, {
                text: bootstrapPrompt,
                sentFrom: 'webapp'
            })
        } catch (error) {
            return {
                type: 'error',
                message: error instanceof Error ? error.message : 'Failed to send continue prompt',
                code: 'convert_failed'
            }
        }

        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    private buildContinueWithPrompt(sourceSessionId: string): string {
        return [
            `Continue work from source session: ${sourceSessionId}.`,
            '',
            'Recover context using these methods (prefer top to bottom):',
            '',
            '1) Ask the source session directly (best for recent context):',
            `   hapi send ${sourceSessionId} "summarize what you were working on and current status" --wait`,
            '',
            '2) Browse recent history:',
            `   hapi session history --session ${sourceSessionId} --tail 30`,
            '',
            '3) Keyword search (for older context beyond the session\'s memory):',
            `   hapi session history --session ${sourceSessionId} --search "<keyword>" --limit 50`,
            '',
            'Rules:',
            '1) Retrieve relevant context before coding.',
            '2) Use hapi send --wait first — it gives richer results than raw history.',
            '3) Fall back to history search only for older records beyond context.',
            '4) Output a short "Recovered context" summary before action.'
        ].join('\n')
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
    }

    async getUsage(machineId: string, provider: 'claude' | 'codex'): Promise<unknown> {
        return await this.rpcGateway.getUsage(machineId, provider)
    }

    async applyCredentials(
        machineId: string,
        agentType: 'claude' | 'codex',
        config: unknown
    ): Promise<RpcApplyCredentialsResponse> {
        return await this.rpcGateway.applyCredentials(machineId, agentType, config)
    }

    async readCredentials(
        machineId: string,
        agentType: 'claude' | 'codex'
    ): Promise<RpcReadCredentialsResponse> {
        return await this.rpcGateway.readCredentials(machineId, agentType)
    }

    async importSshKey(machineId: string, publicKey: string): Promise<RpcImportSshKeyResponse> {
        return await this.rpcGateway.importSshKey(machineId, publicKey)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitStatus(sessionId, cwd)
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffNumstat(sessionId, options)
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.rpcGateway.getGitDiffFile(sessionId, options)
    }

    async readSessionFile(sessionId: string, path: string, cwd?: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path, cwd)
    }

    async listDirectory(sessionId: string, path: string, cwd?: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listDirectory(sessionId, path, cwd)
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.rpcGateway.uploadFile(sessionId, filename, content, mimeType)
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.rpcGateway.deleteUploadFile(sessionId, path)
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.rpcGateway.runRipgrep(sessionId, args, cwd)
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>
        error?: string
    }> {
        return await this.rpcGateway.listSlashCommands(sessionId, agent)
    }

    async listSkills(sessionId: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.rpcGateway.listSkills(sessionId)
    }

    async getSessionDebugState(sessionId: string): Promise<RpcSessionDebugStateResponse> {
        return await this.rpcGateway.getSessionDebugState(sessionId)
    }

    getSessionUiState(sessionId: string, namespace: string): unknown | null {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) {
            return null
        }
        return this.sessionCache.getSessionUiState(sessionId, namespace)
    }

    updateSessionUiState(sessionId: string, namespace: string, uiState: unknown): boolean {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace)
            ?? this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) {
            return false
        }
        return this.sessionCache.updateSessionUiState(sessionId, namespace, uiState)
    }
}
