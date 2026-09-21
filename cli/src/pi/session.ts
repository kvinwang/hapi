import { AgentSessionBase } from '@/agent/sessionBase'
import type { ApiClient, ApiSessionClient } from '@/lib'
import type { MessageQueue2 } from '@/utils/MessageQueue2'
import type { PiMode, PermissionMode } from './types'
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy'

export class PiSession extends AgentSessionBase<PiMode> {
    readonly startedBy: 'runner' | 'terminal'
    readonly startingMode: 'local' | 'remote'
    localLaunchFailure: { message: string; exitReason: LocalLaunchExitReason } | null = null
    piEnv: NodeJS.ProcessEnv | undefined
    providerChanging = false
    restartForProvider: (() => Promise<void>) | undefined

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        sessionId: string | null
        messageQueue: MessageQueue2<PiMode>
        onModeChange: (mode: 'local' | 'remote') => void
        mode: 'local' | 'remote'
        startedBy: 'runner' | 'terminal'
        permissionMode: PermissionMode
        modelMode?: string
    }) {
        super({
            ...opts,
            sessionLabel: 'PiSession',
            sessionIdLabel: 'Pi',
            applySessionIdToMetadata: (metadata, sessionId) => ({ ...metadata, piSessionId: sessionId })
        })
        this.startedBy = opts.startedBy
        this.startingMode = opts.mode
    }

    setPermissionMode(mode: PermissionMode): void { this.permissionMode = mode }
    setModelMode(mode: string | undefined): void { this.modelMode = mode }
    setEffortMode(mode: string | undefined): void { this.effortMode = mode }
    recordLocalLaunchFailure(message: string, exitReason: LocalLaunchExitReason): void {
        this.localLaunchFailure = { message, exitReason }
    }
    sendCodexMessage(message: unknown): void { this.client.sendCodexMessage(message) }
    sendSessionEvent(event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void { this.client.sendSessionEvent(event) }
}
