import type { CredentialConfig } from '@hapi/protocol'

export interface SpawnSessionOptions {
    machineId?: string
    directory: string
    sessionId?: string
    resumeSessionId?: string
    approvedNewDirectoryCreation?: boolean
    agent?: 'claude' | 'codex' | 'cursor' | 'gemini' | 'grok' | 'opencode' | 'pi'
    model?: string
    yolo?: boolean
    token?: string
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    forkSourceSessionId?: string
    forkAtTimestamp?: string
    sessionTag?: string
    parentSessionId?: string
    credential?: CredentialConfig
    credentialId?: string
    credentialName?: string
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string }
