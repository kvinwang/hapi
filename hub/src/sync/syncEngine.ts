/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-hub is the hub (Socket.IO + REST)
 * - hapi CLI connects directly to the hub (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 */

import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { AgentFlavor, DecryptedMessage, Metadata, ModelMode, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import type { RpcRegistry } from '../socket/rpcRegistry'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MachineCache, type Machine } from './machineCache'
import { MessageService } from './messageService'
import {
    RpcGateway,
    type RpcCommandResponse,
    type RpcDeleteUploadResponse,
    type RpcListDirectoryResponse,
    type RpcPathExistsResponse,
    type RpcReadFileResponse,
    type RpcSessionDebugStateResponse,
    type RpcUploadFileResponse
} from './rpcGateway'
import { SessionCache } from './sessionCache'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { Machine } from './machineCache'
export type { SyncEventListener } from './eventPublisher'
export type {
    RpcCommandResponse,
    RpcDeleteUploadResponse,
    RpcListDirectoryResponse,
    RpcPathExistsResponse,
    RpcReadFileResponse,
    RpcSessionDebugStateResponse,
    RpcUploadFileResponse
} from './rpcGateway'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

export type ForkSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'fork_failed' }

export type ConvertSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'already_target_flavor' | 'convert_failed' }

type ConversationSnippet = {
    role: 'user' | 'assistant'
    text: string
}

export class SyncEngine {
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
        sseManager: SSEManager
    ) {
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
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

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    } {
        return this.messageService.getMessagesPage(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
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

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace)
    }

    getOrCreateMachine(id: string, metadata: unknown, runnerState: unknown, namespace: string): Machine {
        return this.machineCache.getOrCreateMachine(id, metadata, runnerState, namespace)
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
            sentFrom?: 'telegram-bot' | 'webapp'
        }
    ): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
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

    async archiveSession(sessionId: string): Promise<void> {
        await this.rpcGateway.killSession(sessionId)
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.rpcGateway.switchSession(sessionId, to)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.sessionCache.deleteSession(sessionId)
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
        agent: 'claude' | 'codex' | 'gemini' | 'opencode' = 'claude',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.rpcGateway.spawnSession(machineId, directory, agent, model, yolo, sessionType, worktreeName, resumeSessionId)
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

        const flavor = metadata.flavor === 'codex' || metadata.flavor === 'gemini' || metadata.flavor === 'opencode'
            ? metadata.flavor
            : 'claude'
        const resumeToken = flavor === 'codex'
            ? metadata.codexSessionId
            : flavor === 'gemini'
                ? metadata.geminiSessionId
                : flavor === 'opencode'
                    ? metadata.opencodeSessionId
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

        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            metadata.path,
            flavor,
            undefined,
            undefined,
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

        const spawnResult = await this.rpcGateway.spawnSession(
            targetMachine.id,
            metadata.path,
            flavor,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            forked.sourceAgentSessionId,
            forked.forkAtTimestamp
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

        const latestMessageSeq = this.messageService.getLatestMessageSeq(sessionId)
        const result = await this.forkSession(sessionId, latestMessageSeq, namespace, targetFlavor)
        if (result.type === 'error') {
            return {
                type: 'error',
                message: result.message,
                code: result.code === 'fork_failed' ? 'convert_failed' : result.code
            }
        }

        const migrationPrompt = this.buildConversionPrompt(access.session, sourceFlavor, targetFlavor)
        if (migrationPrompt) {
            try {
                await this.sendMessage(result.sessionId, {
                    text: migrationPrompt,
                    sentFrom: 'webapp'
                })
            } catch (error) {
                return {
                    type: 'error',
                    message: error instanceof Error ? error.message : 'Failed to send conversion context',
                    code: 'convert_failed'
                }
            }
        }

        return result
    }

    private buildConversionPrompt(sourceSession: Session, sourceFlavor: 'claude' | 'codex', targetFlavor: 'claude' | 'codex'): string | null {
        const summary = this.normalizeSnippetText(sourceSession.metadata?.summary?.text, 1_200)
        const snippets = this.collectRecentConversationSnippets(sourceSession.id, 80, 12)

        if (!summary && snippets.length === 0) {
            return null
        }

        const lines: string[] = [
            '[Session migration context]',
            `This session was converted from ${sourceFlavor} to ${targetFlavor}. Continue the same task without asking for details that already exist in this context.`
        ]

        const path = sourceSession.metadata?.path
        if (typeof path === 'string' && path.trim().length > 0) {
            lines.push(`Workspace: ${path.trim()}`)
        }

        if (summary) {
            lines.push(`Conversation summary from previous session:\n${summary}`)
        }

        if (snippets.length > 0) {
            const snippetLines = snippets.map((snippet, idx) => (
                `${idx + 1}. ${snippet.role === 'user' ? 'User' : 'Assistant'}: ${snippet.text}`
            ))
            lines.push(`Recent conversation excerpts (oldest -> newest):\n${snippetLines.join('\n')}`)
        }

        lines.push('Please continue from the user\'s latest intent.')
        return lines.join('\n\n')
    }

    private collectRecentConversationSnippets(sessionId: string, messageLimit: number, snippetLimit: number): ConversationSnippet[] {
        const page = this.getMessagesPage(sessionId, { limit: messageLimit, beforeSeq: null })
        const snippets: ConversationSnippet[] = []
        for (const message of page.messages) {
            const snippet = this.extractConversationSnippet(message)
            if (snippet) {
                snippets.push(snippet)
            }
        }
        if (snippets.length <= snippetLimit) {
            return snippets
        }
        return snippets.slice(-snippetLimit)
    }

    private extractConversationSnippet(message: DecryptedMessage): ConversationSnippet | null {
        const record = unwrapRoleWrappedRecordEnvelope(message.content)
        if (!record) {
            return null
        }

        const role = record.role === 'user'
            ? 'user'
            : record.role === 'agent'
                ? 'assistant'
                : null
        if (!role) {
            return null
        }

        const text = this.extractTextFromMessageContent(record.content)
        if (!text) {
            return null
        }

        const normalized = this.normalizeSnippetText(text, 320)
        if (!normalized) {
            return null
        }

        return { role, text: normalized }
    }

    private extractTextFromMessageContent(content: unknown, depth: number = 0): string | null {
        if (depth > 5 || content === null || content === undefined) {
            return null
        }

        if (typeof content === 'string') {
            return content
        }

        if (Array.isArray(content)) {
            const parts: string[] = []
            for (const entry of content) {
                if (!isObject(entry)) {
                    continue
                }
                const type = typeof entry.type === 'string' ? entry.type : ''
                if ((type === 'text' || type === 'input_text') && typeof entry.text === 'string') {
                    parts.push(entry.text)
                    continue
                }
                if (type === 'tool_result' && typeof entry.content === 'string') {
                    parts.push(entry.content)
                    continue
                }
                const nested = this.extractTextFromMessageContent(entry.content, depth + 1)
                if (nested) {
                    parts.push(nested)
                }
            }
            return parts.join('\n').trim() || null
        }

        if (!isObject(content)) {
            return null
        }

        if (content.type === 'text' && typeof content.text === 'string') {
            return content.text
        }
        if (typeof content.text === 'string') {
            return content.text
        }

        if (content.type === 'output' && isObject(content.data) && isObject(content.data.message)) {
            const nested = this.extractTextFromMessageContent(content.data.message.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        if (isObject(content.message)) {
            const nested = this.extractTextFromMessageContent(content.message.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        if (isObject(content.data)) {
            if (isObject(content.data.message)) {
                const nested = this.extractTextFromMessageContent(content.data.message.content, depth + 1)
                if (nested) {
                    return nested
                }
            }
            const nested = this.extractTextFromMessageContent(content.data.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        if (isObject(content.payload)) {
            const nested = this.extractTextFromMessageContent(content.payload.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        const nested = this.extractTextFromMessageContent(content.content, depth + 1)
        if (nested) {
            return nested
        }

        return null
    }

    private normalizeSnippetText(raw: unknown, maxLength: number): string | null {
        if (typeof raw !== 'string') {
            return null
        }
        const trimmed = raw.replace(/\s+/g, ' ').trim()
        if (!trimmed) {
            return null
        }
        if (trimmed.length <= maxLength) {
            return trimmed
        }
        return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.rpcGateway.checkPathsExist(machineId, paths)
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

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.rpcGateway.readSessionFile(sessionId, path)
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.rpcGateway.listDirectory(sessionId, path)
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
