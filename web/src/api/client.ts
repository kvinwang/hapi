import type {
    ApiKeysResponse,
    ApiKeyPermission,
    ApplyCredentialsResponse,
    AttachmentMetadata,
    AuthResponse,
    CreateApiKeyResponse,
    CredentialResponse,
    CredentialsResponse,
    DeleteUploadResponse,
    ListDirectoryResponse,
    FileReadResponse,
    FileSearchResponse,
    GitCommandResponse,
    AccessTokensResponse,
    UpdateApiKeyResponse,
    MachinePathsExistsResponse,
    MachinesResponse,
    ManagedMachinesResponse,
    ReadCredentialsResponse,
    MessagesResponse,
    ModelMode,
    PermissionMode,
    PushSubscriptionPayload,
    PushUnsubscribePayload,
    PushVapidPublicKeyResponse,
    SessionShareStatusResponse,
    ShareSessionResponse,
    SharedSessionResponse,
    SharedSessionsResponse,
    SlashCommandsResponse,
    SkillsResponse,
    SpawnResponse,
    UploadFileResponse,
    VisibilityPayload,
    SessionResponse,
    SessionDebugStateResponse,
    SessionsResponse,
    SessionUiState,
    PreferencesResponse,
    UsageResponse,
    SpeakersResponse,
    SpeakerResponse
} from '@/types/api'

type ApiClientOptions = {
    baseUrl?: string
    onUnauthorized?: () => Promise<boolean>
}

type ErrorPayload = {
    error?: unknown
}

function parseErrorCode(bodyText: string): string | undefined {
    try {
        const parsed = JSON.parse(bodyText) as ErrorPayload
        return typeof parsed.error === 'string' ? parsed.error : undefined
    } catch {
        return undefined
    }
}

export class ApiError extends Error {
    status: number
    code?: string
    body?: string

    constructor(message: string, status: number, code?: string, body?: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.body = body
    }
}

export class ApiClient {
    private readonly baseUrl: string | null
    private readonly onUnauthorized: (() => Promise<boolean>) | null

    constructor(options?: ApiClientOptions) {
        this.baseUrl = options?.baseUrl ?? null
        this.onUnauthorized = options?.onUnauthorized ?? null
    }

    private buildUrl(path: string): string {
        if (!this.baseUrl) {
            return path
        }
        try {
            return new URL(path, this.baseUrl).toString()
        } catch {
            return path
        }
    }

    private async request<T>(
        path: string,
        init?: RequestInit,
        attempt: number = 0,
    ): Promise<T> {
        const headers = new Headers(init?.headers)
        if (init?.body !== undefined && !headers.has('content-type')) {
            headers.set('content-type', 'application/json')
        }

        const res = await fetch(this.buildUrl(path), {
            ...init,
            headers,
            credentials: 'include',
        })

        if (res.status === 401) {
            if (attempt === 0 && this.onUnauthorized) {
                const refreshed = await this.onUnauthorized()
                if (refreshed) {
                    return await this.request<T>(path, init, attempt + 1)
                }
            }
            throw new Error('Session expired. Please sign in again.')
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${body}`)
        }

        return await res.json() as T
    }

    async authenticate(auth: { initData: string } | { accessToken: string }): Promise<AuthResponse> {
        const res = await fetch(this.buildUrl('/api/auth'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth),
            credentials: 'include',
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Auth failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async bind(auth: { initData: string; accessToken: string }): Promise<AuthResponse> {
        const res = await fetch(this.buildUrl('/api/bind'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Bind failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async getSessions(): Promise<SessionsResponse> {
        return await this.request<SessionsResponse>('/api/sessions')
    }

    async getPushVapidPublicKey(): Promise<PushVapidPublicKeyResponse> {
        return await this.request<PushVapidPublicKeyResponse>('/api/push/vapid-public-key')
    }

    async subscribePushNotifications(payload: PushSubscriptionPayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async unsubscribePushNotifications(payload: PushUnsubscribePayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'DELETE',
            body: JSON.stringify(payload)
        })
    }

    async setVisibility(payload: VisibilityPayload): Promise<void> {
        await this.request('/api/visibility', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async getSession(sessionId: string): Promise<SessionResponse> {
        return await this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    }

    async getMessages(
        sessionId: string,
        options: { beforeSeq?: number | null; afterSeq?: number | null; limit?: number; role?: 'user' | 'assistant' | 'tool' }
    ): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.afterSeq !== undefined && options.afterSeq !== null) {
            params.set('afterSeq', `${options.afterSeq}`)
        } else if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }
        if (options.role) {
            params.set('role', options.role)
        }

        const qs = params.toString()
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
        return await this.request<MessagesResponse>(url)
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        if (cwd) params.set('cwd', cwd)
        const qs = params.toString()
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-status${qs ? `?${qs}` : ''}`)
    }

    async getGitDiffNumstat(sessionId: string, staged: boolean, cwd?: string): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('staged', staged ? 'true' : 'false')
        if (cwd) params.set('cwd', cwd)
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`)
    }

    async getGitDiffFile(sessionId: string, path: string, staged?: boolean, cwd?: string): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (staged !== undefined) {
            params.set('staged', staged ? 'true' : 'false')
        }
        if (cwd) params.set('cwd', cwd)
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`)
    }

    async searchSessionFiles(sessionId: string, query: string, limit?: number, cwd?: string): Promise<FileSearchResponse> {
        const params = new URLSearchParams()
        if (query) {
            params.set('query', query)
        }
        if (limit !== undefined) {
            params.set('limit', `${limit}`)
        }
        if (cwd) params.set('cwd', cwd)
        const qs = params.toString()
        return await this.request<FileSearchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ''}`)
    }

    async readSessionFile(sessionId: string, path: string, cwd?: string): Promise<FileReadResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (cwd) params.set('cwd', cwd)
        return await this.request<FileReadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`)
    }

    async listSessionDirectory(sessionId: string, path?: string, cwd?: string): Promise<ListDirectoryResponse> {
        const params = new URLSearchParams()
        if (path) {
            params.set('path', path)
        }
        if (cwd) params.set('cwd', cwd)

        const qs = params.toString()
        return await this.request<ListDirectoryResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/directory${qs ? `?${qs}` : ''}`
        )
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<UploadFileResponse> {
        return await this.request<UploadFileResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload`, {
            method: 'POST',
            body: JSON.stringify({ filename, content, mimeType })
        })
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<DeleteUploadResponse> {
        return await this.request<DeleteUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload/delete`, {
            method: 'POST',
            body: JSON.stringify({ path })
        })
    }

    async resumeSession(sessionId: string): Promise<string> {
        const response = await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
            { method: 'POST' }
        )
        return response.sessionId
    }

    async forkSession(sessionId: string, messageSeq: number): Promise<string> {
        const response = await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
            { method: 'POST', body: JSON.stringify({ messageSeq }) }
        )
        return response.sessionId
    }

    async convertSession(sessionId: string, targetAgent: 'claude' | 'codex'): Promise<string> {
        const response = await this.request<{ sessionId: string }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/convert`,
            { method: 'POST', body: JSON.stringify({ targetAgent }) }
        )
        return response.sessionId
    }

    async getSessionUiState(sessionId: string): Promise<SessionUiState> {
        const response = await this.request<{ state: SessionUiState }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/ui-state`
        )
        return response.state ?? {}
    }

    async getSessionDebugState(sessionId: string): Promise<SessionDebugStateResponse> {
        return await this.request<SessionDebugStateResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/debug-state`
        )
    }

    async updateSessionUiState(sessionId: string, state: SessionUiState): Promise<SessionUiState> {
        const response = await this.request<{ state: SessionUiState }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/ui-state`,
            {
                method: 'POST',
                body: JSON.stringify(state)
            }
        )
        return response.state ?? {}
    }

    async getPreferences(): Promise<PreferencesResponse> {
        return await this.request<PreferencesResponse>('/api/preferences')
    }

    async updatePreferences(prefs: { systemPrompt?: string }): Promise<PreferencesResponse> {
        return await this.request<PreferencesResponse>('/api/preferences', {
            method: 'POST',
            body: JSON.stringify(prefs)
        })
    }

    async sendMessage(sessionId: string, text: string, localId?: string | null, attachments?: AttachmentMetadata[]): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                text,
                localId: localId ?? undefined,
                attachments: attachments ?? undefined
            })
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async switchSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/switch`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setModelMode(sessionId: string, model: ModelMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify({ model })
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        modeOrOptions?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | {
            mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
            allowTools?: string[]
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
            answers?: Record<string, string[]> | Record<string, { answers: string[] }>
        }
    ): Promise<void> {
        const body = typeof modeOrOptions === 'string' || modeOrOptions === undefined
            ? { mode: modeOrOptions }
            : modeOrOptions
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`, {
            method: 'POST',
            body: JSON.stringify(body)
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        options?: {
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
        }
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`, {
            method: 'POST',
            body: JSON.stringify(options ?? {})
        })
    }

    async getMachines(): Promise<MachinesResponse> {
        return await this.request<MachinesResponse>('/api/machines')
    }

    async getManagedMachines(): Promise<ManagedMachinesResponse> {
        return await this.request<ManagedMachinesResponse>('/api/machines?manage=true')
    }

    async unbindMachine(machineId: string): Promise<{ ok: boolean }> {
        return await this.request<{ ok: boolean }>(`/api/machines/${encodeURIComponent(machineId)}/unbind`, {
            method: 'POST',
        })
    }

    async checkMachinePathsExists(
        machineId: string,
        paths: string[]
    ): Promise<MachinePathsExistsResponse> {
        return await this.request<MachinePathsExistsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/paths/exists`,
            {
                method: 'POST',
                body: JSON.stringify({ paths })
            }
        )
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent?: 'claude' | 'codex' | 'gemini' | 'opencode',
        model?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string
    ): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({ directory, agent, model, yolo, sessionType, worktreeName })
        })
    }

    async createInvite(): Promise<{ ok: boolean; code: string; expiresAt: number; command: string }> {
        return await this.request<{ ok: boolean; code: string; expiresAt: number; command: string }>('/api/invites', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async getSessionUsage(sessionId: string): Promise<UsageResponse> {
        return await this.request<UsageResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/usage`)
    }

    async getSlashCommands(sessionId: string): Promise<SlashCommandsResponse> {
        return await this.request<SlashCommandsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`
        )
    }

    async getSkills(sessionId: string): Promise<SkillsResponse> {
        return await this.request<SkillsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/skills`
        )
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name })
        })
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE'
        })
    }

    async fetchVoiceToken(options?: { customAgentId?: string; customApiKey?: string }): Promise<{
        allowed: boolean
        token?: string
        agentId?: string
        error?: string
    }> {
        return await this.request('/api/voice/token', {
            method: 'POST',
            body: JSON.stringify(options || {})
        })
    }

    async shareSession(sessionId: string): Promise<ShareSessionResponse> {
        return await this.request<ShareSessionResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/share`,
            { method: 'POST', body: JSON.stringify({}) }
        )
    }

    async unshareSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/share`, {
            method: 'DELETE'
        })
    }

    async getSessionShareStatus(sessionId: string): Promise<SessionShareStatusResponse> {
        return await this.request<SessionShareStatusResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/share`
        )
    }

    async getSharedSessions(): Promise<SharedSessionsResponse> {
        return await this.request<SharedSessionsResponse>('/api/sessions/shared')
    }

    async getCredentials(): Promise<CredentialsResponse> {
        return await this.request<CredentialsResponse>('/api/credentials')
    }

    async createCredential(params: {
        name: string
        agentType: 'claude' | 'codex'
        config: unknown
    }): Promise<CredentialResponse> {
        return await this.request<CredentialResponse>('/api/credentials', {
            method: 'POST',
            body: JSON.stringify(params)
        })
    }

    async updateCredential(id: string, params: {
        name?: string
        config?: unknown
    }): Promise<CredentialResponse> {
        return await this.request<CredentialResponse>(
            `/api/credentials/${encodeURIComponent(id)}`,
            { method: 'PUT', body: JSON.stringify(params) }
        )
    }

    async deleteCredential(id: string): Promise<void> {
        await this.request(`/api/credentials/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
    }

    async readMachineCredentials(machineId: string, agentType: 'claude' | 'codex'): Promise<ReadCredentialsResponse> {
        return await this.request<ReadCredentialsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/read-credentials?agentType=${encodeURIComponent(agentType)}`
        )
    }

    async applyCredentials(machineId: string, params: {
        credentialId: string
        agentType: 'claude' | 'codex'
    }): Promise<ApplyCredentialsResponse> {
        return await this.request<ApplyCredentialsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/apply-credentials`,
            { method: 'POST', body: JSON.stringify(params) }
        )
    }

    async getApiKeys(): Promise<ApiKeysResponse> {
        return await this.request<ApiKeysResponse>('/api/api-keys')
    }

    async createApiKey(params: {
        name: string
        namespace?: string
        permissions?: ApiKeyPermission[]
    }): Promise<CreateApiKeyResponse> {
        return await this.request<CreateApiKeyResponse>('/api/api-keys', {
            method: 'POST',
            body: JSON.stringify(params)
        })
    }

    async updateApiKeyPermissions(id: string, permissions: ApiKeyPermission[]): Promise<UpdateApiKeyResponse> {
        return await this.request<UpdateApiKeyResponse>(`/api/api-keys/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ permissions })
        })
    }

    async revokeApiKey(id: string): Promise<void> {
        await this.request(`/api/api-keys/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
    }

    async restoreApiKey(id: string): Promise<void> {
        await this.request(`/api/api-keys/${encodeURIComponent(id)}/restore`, {
            method: 'POST'
        })
    }

    async getAccessTokens(apiKeyId: string): Promise<AccessTokensResponse> {
        return await this.request<AccessTokensResponse>(
            `/api/api-keys/${encodeURIComponent(apiKeyId)}/tokens`
        )
    }

    async revokeAccessToken(apiKeyId: string, tokenId: string): Promise<void> {
        await this.request(
            `/api/api-keys/${encodeURIComponent(apiKeyId)}/tokens/${encodeURIComponent(tokenId)}`,
            { method: 'DELETE' }
        )
    }

    async getSpeakers(): Promise<SpeakersResponse> {
        return await this.request<SpeakersResponse>('/api/lobstear/devices')
    }

    async createSpeaker(params: { id: string; name: string; sessionId?: string }): Promise<SpeakerResponse> {
        return await this.request<SpeakerResponse>('/api/lobstear/devices', {
            method: 'POST',
            body: JSON.stringify(params)
        })
    }

    async updateSpeaker(id: string, params: { name?: string; sessionId?: string | null }): Promise<SpeakerResponse> {
        return await this.request<SpeakerResponse>(`/api/lobstear/devices/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(params)
        })
    }

    async deleteSpeaker(id: string): Promise<void> {
        await this.request(`/api/lobstear/devices/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
    }

    static async getSharedSession(baseUrl: string, shareToken: string): Promise<SharedSessionResponse> {
        const url = `${baseUrl}/api/share/${encodeURIComponent(shareToken)}`
        const res = await fetch(url)
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        return await res.json() as SharedSessionResponse
    }

    static async getSharedMessages(
        baseUrl: string,
        shareToken: string,
        options: { beforeSeq?: number | null; afterSeq?: number | null; limit?: number }
    ): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.afterSeq !== undefined && options.afterSeq !== null) {
            params.set('afterSeq', `${options.afterSeq}`)
        } else if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }
        const qs = params.toString()
        const url = `${baseUrl}/api/share/${encodeURIComponent(shareToken)}/messages${qs ? `?${qs}` : ''}`
        const res = await fetch(url)
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        return await res.json() as MessagesResponse
    }
}
