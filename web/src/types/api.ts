import type {
    DecryptedMessage as ProtocolDecryptedMessage,
    Session,
    SessionSummary,
    SyncEvent as ProtocolSyncEvent,
    WorktreeMetadata
} from '@hapi/protocol/types'

export type {
    AgentState,
    AttachmentMetadata,
    ModelMode,
    PermissionMode,
    Session,
    SessionSummary,
    SessionSummaryMetadata,
    TodoItem,
    WorktreeMetadata
} from '@hapi/protocol/types'

export type SessionMetadataSummary = {
    path: string
    host: string
    version?: string
    name?: string
    os?: string
    summary?: { text: string; updatedAt: number }
    machineId?: string
    tools?: string[]
    flavor?: string | null
    worktree?: WorktreeMetadata
}

export type MessageStatus = 'sending' | 'sent' | 'failed'

export type DecryptedMessage = ProtocolDecryptedMessage & {
    status?: MessageStatus
    originalText?: string
}

export type Machine = {
    id: string
    active: boolean
    metadata: {
        host: string
        platform: string
        happyCliVersion: string
        displayName?: string
    } | null
}

export type ManagedMachine = {
    id: string
    namespace: string
    active: boolean
    activeAt: number
    createdAt: number
    updatedAt: number
    metadata: {
        host: string
        platform: string
        happyCliVersion: string
        displayName?: string
    } | null
    apiKeyId: string | null
    apiKeyName: string | null
}

export type ManagedMachinesResponse = { machines: ManagedMachine[] }

export type AuthResponse = {
    token: string
    user: {
        id: number
        username?: string
        firstName?: string
        lastName?: string
    }
}

export type SessionsResponse = { sessions: SessionSummary[] }
export type SessionResponse = { session: Session }
export type SessionUiState = {
    files?: {
        searchQuery?: string
        tab?: 'changes' | 'directories'
    }
    terminal?: {
        cols?: number
        rows?: number
    }
    pinned?: boolean
    tags?: string[]
    systemPrompt?: string
    useGlobalPrompt?: boolean
}

export type PreferencesResponse = {
    systemPrompt: string
}

export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        beforeSeq: number | null
        nextBeforeSeq: number | null
        afterSeq: number | null
        nextAfterSeq: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }
export type MachinePathsExistsResponse = { exists: Record<string, boolean> }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

export type GitCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type FileSearchItem = {
    fileName: string
    filePath: string
    fullPath: string
    fileType: 'file' | 'folder'
}

export type FileSearchResponse = {
    success: boolean
    files?: FileSearchItem[]
    error?: string
}

export type DirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
}

export type ListDirectoryResponse = {
    success: boolean
    entries?: DirectoryEntry[]
    error?: string
}

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type UploadFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type DeleteUploadResponse = {
    success: boolean
    error?: string
}

export type GitFileStatus = {
    fileName: string
    filePath: string
    fullPath: string
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
    isStaged: boolean
    linesAdded: number
    linesRemoved: number
    oldPath?: string
}

export type GitStatusFiles = {
    stagedFiles: GitFileStatus[]
    unstagedFiles: GitFileStatus[]
    branch: string | null
    totalStaged: number
    totalUnstaged: number
}

export type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user' | 'plugin'
    content?: string  // Expanded content for Codex user prompts
    pluginName?: string
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}

export type SkillSummary = {
    name: string
    description?: string
}

export type SkillsResponse = {
    success: boolean
    skills?: SkillSummary[]
    error?: string
}

export type SessionDebugStateResponse = {
    success: boolean
    timestamp?: number
    launcher?: Record<string, unknown>
    outgoingQueue?: Record<string, unknown>
    error?: string
}

export type UsageRateLimit = {
    utilization: number
    resets_at: string
}

export type ClaudeUsagePayload = {
    five_hour?: UsageRateLimit | null
    seven_day?: UsageRateLimit | null
    seven_day_oauth_apps?: UsageRateLimit | null
    seven_day_opus?: UsageRateLimit | null
    seven_day_sonnet?: UsageRateLimit | null
    seven_day_cowork?: UsageRateLimit | null
    iguana_necktie?: UsageRateLimit | null
    extra_usage?: {
        is_enabled: boolean
        monthly_limit: number | null
        used_credits: number | null
        utilization: number | null
    } | null
}

export type CodexUsageWindow = {
    used_percent?: number | null
    reset_at?: number | null
    reset_after_seconds?: number | null
    limit_window_seconds?: number | null
}

export type CodexUsagePayload = {
    user_id?: string | null
    account_id?: string | null
    email?: string | null
    plan_type?: string | null
    rate_limit?: {
        allowed?: boolean | null
        limit_reached?: boolean | null
        primary_window?: CodexUsageWindow | null
        secondary_window?: CodexUsageWindow | null
    } | null
    code_review_rate_limit?: {
        allowed?: boolean | null
        limit_reached?: boolean | null
        primary_window?: CodexUsageWindow | null
        secondary_window?: CodexUsageWindow | null
    } | null
    additional_rate_limits?: unknown
    credits?: {
        has_credits?: boolean | null
        unlimited?: boolean | null
        balance?: string | null
        approx_local_messages?: number[] | null
        approx_cloud_messages?: number[] | null
    } | null
    promo?: unknown
}

export type UsageResponse = {
    success: boolean
    provider?: 'claude' | 'codex'
    usage?: ClaudeUsagePayload | CodexUsagePayload
    error?: string
}

export type PushSubscriptionKeys = {
    p256dh: string
    auth: string
}

export type PushSubscriptionPayload = {
    endpoint: string
    keys: PushSubscriptionKeys
}

export type PushUnsubscribePayload = {
    endpoint: string
}

export type PushVapidPublicKeyResponse = {
    publicKey: string
}

export type VisibilityPayload = {
    subscriptionId: string
    visibility: 'visible' | 'hidden'
}

export type SharedSessionResponse = {
    session: {
        id: string
        title: string
        flavor: string | null
        createdAt: number
        updatedAt: number
        active: boolean
    }
}

export type ShareSessionResponse = {
    shareToken: string
}

export type SessionShareStatusResponse = {
    shareToken: string | null
}

export type SharedSessionSummary = {
    id: string
    title: string
    flavor: string | null
    active: boolean
    createdAt: number
    updatedAt: number
}

export type SharedSessionsResponse = {
    sessions: SharedSessionSummary[]
}

export type AgentType = 'claude' | 'codex'

export type Credential = {
    id: string
    name: string
    agentType: AgentType
    config: unknown
    createdAt: number
    updatedAt: number
}

export type CredentialsResponse = {
    credentials: Credential[]
}

export type CredentialResponse = {
    credential: Credential
}

export type ApplyCredentialsResponse = {
    success: boolean
    error?: string
    written?: string[]
}

export type ReadCredentialsResponse = {
    success: boolean
    agentType?: AgentType
    config?: unknown
    error?: string
}

export type ApiKeyPermission = 'admin' | 'api_keys:manage' | 'sessions:read' | 'sessions:read:all' | 'sessions:write' | 'machines:read' | 'machines:read:all' | 'machines:write' | 'machines:manage' | 'machines:ssh:manage'

export type ApiKey = {
    id: string
    name: string
    keyPrefix: string
    namespace: string
    permissions: ApiKeyPermission[]
    createdAt: number
    revokedAt: number | null
    lastUsedAt: number | null
}

export type ApiKeysResponse = {
    apiKeys: ApiKey[]
}

export type CreateApiKeyResponse = {
    apiKey: ApiKey
    rawKey: string
}

export type UpdateApiKeyResponse = {
    apiKey: ApiKey
}

export type AccessToken = {
    id: string
    apiKeyId: string
    name: string
    tokenPrefix: string
    namespace: string
    permissions: ApiKeyPermission[]
    createdAt: number
    expiresAt: number
    revokedAt: number | null
}

export type AccessTokensResponse = {
    tokens: AccessToken[]
}

export type SyncEvent = ProtocolSyncEvent
