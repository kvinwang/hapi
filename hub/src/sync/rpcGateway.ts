import type { ModelMode, PermissionMode } from '@hapi/protocol/types'
import type { Server } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'

export type RpcCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type RpcReadFileResponse = {
    success: boolean
    content?: string
    error?: string
}

export type RpcUploadFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type RpcDeleteUploadResponse = {
    success: boolean
    error?: string
}

export type RpcDirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
}

export type RpcListDirectoryResponse = {
    success: boolean
    entries?: RpcDirectoryEntry[]
    error?: string
}

export type RpcPathExistsResponse = {
    exists: Record<string, boolean>
}

export type RpcSessionDebugStateResponse = {
    success: boolean
    timestamp?: number
    launcher?: Record<string, unknown>
    outgoingQueue?: Record<string, unknown>
    error?: string
}

export type RpcApplyCredentialsResponse = {
    success: boolean
    error?: string
    written?: string[]
}

export type RpcReadCredentialsResponse = {
    success: boolean
    agentType?: string
    config?: unknown
    error?: string
}

export type RpcImportSshKeyResponse = {
    success: boolean
    added?: boolean
    message?: string
    error?: string
}

export class RpcGateway {
    constructor(
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry
    ) {
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: true,
            mode,
            allowTools,
            decision,
            answers
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted via Telegram Bot' })
    }

    async interruptSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'interrupt', {})
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, 'switch', { to })
    }

    async requestSessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            modelMode?: ModelMode
            effortMode?: import('@hapi/protocol/types').EffortMode
        }
    ): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'set-session-config', config)
    }

    async killSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'killSession', {})
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: 'claude' | 'codex' | 'cursor' | 'gemini' | 'grok' | 'opencode' = 'claude',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        forkSourceSessionId?: string,
        forkAtTimestamp?: string,
        sessionTag?: string,
        parentSessionId?: string
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                'spawn-happy-session',
                { type: 'spawn-in-directory', directory, agent, model, yolo, sessionType, worktreeName, resumeSessionId, forkSourceSessionId, forkAtTimestamp, sessionTag, parentSessionId }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    return { type: 'success', sessionId: obj.sessionId }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    return { type: 'error', message: obj.errorMessage }
                }
                if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
                    return { type: 'error', message: `Directory creation requires approval: ${obj.directory}` }
                }
                if (typeof obj.error === 'string') {
                    return { type: 'error', message: obj.error }
                }
                if (obj.type !== 'success' && typeof obj.message === 'string') {
                    return { type: 'error', message: obj.message }
                }
            }
            // If we get here, the result didn't match expected shapes.
            // Try to extract any error message from the result.
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (typeof obj.error === 'string') {
                    return { type: 'error', message: obj.error }
                }
            }
            const details = typeof result === 'string'
                ? result
                : (() => {
                    try {
                        return JSON.stringify(result)
                    } catch {
                        return String(result)
                    }
                })()
            return { type: 'error', message: `Unexpected spawn result: ${details}` }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        const result = await this.machineRpc(machineId, 'path-exists', { paths }) as RpcPathExistsResponse | unknown
        if (!result || typeof result !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const existsValue = (result as RpcPathExistsResponse).exists
        if (!existsValue || typeof existsValue !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const exists: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(existsValue)) {
            exists[key] = value === true
        }
        return exists
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-status', { cwd }) as RpcCommandResponse
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-numstat', options) as RpcCommandResponse
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-file', options) as RpcCommandResponse
    }

    async readSessionFile(sessionId: string, path: string, cwd?: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, 'readFile', { path, cwd }) as RpcReadFileResponse
    }

    async listDirectory(sessionId: string, path: string, cwd?: string): Promise<RpcListDirectoryResponse> {
        return await this.sessionRpc(sessionId, 'listDirectory', { path, cwd }) as RpcListDirectoryResponse
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.sessionRpc(sessionId, 'uploadFile', { sessionId, filename, content, mimeType }) as RpcUploadFileResponse
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.sessionRpc(sessionId, 'deleteUpload', { sessionId, path }) as RpcDeleteUploadResponse
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'ripgrep', { args, cwd }) as RpcCommandResponse
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<{
        success: boolean
        commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' | 'plugin' | 'project' }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSlashCommands', { agent }) as {
            success: boolean
            commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' | 'plugin' | 'project' }>
            error?: string
        }
    }

    async listSkills(sessionId: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, 'listSkills', {}) as {
            success: boolean
            skills?: Array<{ name: string; description?: string }>
            error?: string
        }
    }

    async getSessionDebugState(sessionId: string): Promise<RpcSessionDebugStateResponse> {
        return await this.sessionRpc(sessionId, 'debug-session-state', {}) as RpcSessionDebugStateResponse
    }

    async getCodexGoal(sessionId: string): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'codex-goal-get', {})
    }

    async getClaudeUsage(sessionId: string): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'claude-usage-get', {})
    }

    async setCodexGoal(sessionId: string, params: unknown): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'codex-goal-set', params)
    }

    async clearCodexGoal(sessionId: string): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'codex-goal-clear', {})
    }

    async getUsage(machineId: string, provider: 'claude' | 'codex' | 'grok'): Promise<unknown> {
        return await this.machineRpc(machineId, 'get-usage', { provider })
    }

    async applyCredentials(
        machineId: string,
        agentType: 'claude' | 'codex',
        config: unknown
    ): Promise<RpcApplyCredentialsResponse> {
        const result = await this.machineRpc(machineId, 'apply-credentials', { agentType, config })
        if (result && typeof result === 'object') {
            const obj = result as Record<string, unknown>
            return {
                success: obj.success === true,
                error: typeof obj.error === 'string' ? obj.error : undefined,
                written: Array.isArray(obj.written) ? obj.written as string[] : undefined
            }
        }
        return { success: false, error: 'Unexpected apply-credentials result' }
    }

    async readCredentials(
        machineId: string,
        agentType: 'claude' | 'codex'
    ): Promise<RpcReadCredentialsResponse> {
        const result = await this.machineRpc(machineId, 'read-credentials', { agentType })
        if (result && typeof result === 'object') {
            const obj = result as Record<string, unknown>
            return {
                success: obj.success === true,
                agentType: typeof obj.agentType === 'string' ? obj.agentType : undefined,
                config: obj.config,
                error: typeof obj.error === 'string' ? obj.error : undefined
            }
        }
        return { success: false, error: 'Unexpected read-credentials result' }
    }

    async importSshKey(machineId: string, publicKey: string): Promise<RpcImportSshKeyResponse> {
        const result = await this.machineRpc(machineId, 'import-ssh-key', { publicKey })
        if (result && typeof result === 'object') {
            const obj = result as Record<string, unknown>
            return {
                success: obj.success === true,
                added: typeof obj.added === 'boolean' ? obj.added : undefined,
                message: typeof obj.message === 'string' ? obj.message : undefined,
                error: typeof obj.error === 'string' ? obj.error : undefined
            }
        }
        return { success: false, error: 'Unexpected import-ssh-key result' }
    }

    private async sessionRpc(sessionId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${sessionId}:${method}`, params)
    }

    private async machineRpc(machineId: string, method: string, params: unknown): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params)
    }

    private async rpcCall(method: string, params: unknown): Promise<unknown> {
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        if (!socketId) {
            throw new Error(`RPC handler not registered: ${method}`)
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new Error(`RPC socket disconnected: ${method}`)
        }

        const response = await socket.timeout(30_000).emitWithAck('rpc-request', {
            method,
            params: JSON.stringify(params)
        }) as unknown

        if (typeof response !== 'string') {
            return response
        }

        try {
            return JSON.parse(response) as unknown
        } catch {
            return response
        }
    }
}
