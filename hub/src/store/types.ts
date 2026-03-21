export type StoredSession = {
    id: string
    tag: string | null
    parentSessionId: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    todos: unknown | null
    todosUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    seq: number
    uiState: unknown | null
    uiStateUpdatedAt: number | null
    shareToken: string | null
}

export type StoredMachine = {
    id: string
    namespace: string
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    runnerState: unknown | null
    runnerStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
    apiKeyId: string | null
    notes: string | null
}

export type StoredMessage = {
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
    role: 'user' | 'assistant' | 'tool' | null
}

export type StoredUser = {
    id: number
    platform: string
    platformUserId: string
    namespace: string
    createdAt: number
}

export type StoredPushSubscription = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    createdAt: number
}

export type StoredCredential = {
    id: string
    namespace: string
    name: string
    agentType: string
    config: unknown
    createdAt: number
    updatedAt: number
}

export type StoredMachineCredential = {
    machineId: string
    agentType: string
    credentialId: string
    appliedAt: number
}

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }

export type Permission = 'admin' | 'api_keys:manage' | 'sessions:read' | 'sessions:read:all' | 'sessions:write' | 'machines:read' | 'machines:read:all' | 'machines:write' | 'machines:manage' | 'machines:connect' | 'machines:shell' | 'machines:ssh:manage'

export type StoredApiKey = {
    id: string
    name: string
    keyHash: string
    keyPrefix: string
    namespace: string
    permissions: Permission[]
    createdAt: number
    revokedAt: number | null
    lastUsedAt: number | null
}

export type StoredAccessToken = {
    id: string
    apiKeyId: string
    name: string
    tokenHash: string
    tokenPrefix: string
    namespace: string
    permissions: Permission[]
    createdAt: number
    expiresAt: number
    revokedAt: number | null
}
