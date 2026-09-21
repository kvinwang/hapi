import type { ApiClient, ApiSessionClient } from '@/lib'
import { runLocalRemoteSession } from '@/agent/loopBase'
import type { MessageQueue2 } from '@/utils/MessageQueue2'
import { logger } from '@/ui/logger'
import type { PiMode, PermissionMode } from './types'
import { PiSession } from './session'
import { piLocalLauncher } from './piLocalLauncher'
import { piRemoteLauncher } from './piRemoteLauncher'

export async function piLoop(opts: {
    path: string
    startingMode: 'local' | 'remote'
    startedBy: 'runner' | 'terminal'
    onModeChange: (mode: 'local' | 'remote') => void
    messageQueue: MessageQueue2<PiMode>
    session: ApiSessionClient
    api: ApiClient
    permissionMode: PermissionMode
    model?: string
    resumeSessionId?: string
    onSessionReady?: (session: PiSession) => void
}): Promise<void> {
    const session = new PiSession({
        api: opts.api, client: opts.session, path: opts.path, logPath: logger.getLogPath(),
        sessionId: opts.resumeSessionId ?? null, messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange, mode: opts.startingMode, startedBy: opts.startedBy,
        permissionMode: opts.permissionMode, modelMode: opts.model
    })
    if (opts.resumeSessionId) session.onSessionFound(opts.resumeSessionId)
    await runLocalRemoteSession({
        session, startingMode: opts.startingMode, logTag: 'pi-loop',
        runLocal: (instance) => piLocalLauncher(instance, { model: instance.getModelMode() }),
        runRemote: (instance) => piRemoteLauncher(instance, { model: instance.getModelMode() }),
        onSessionReady: opts.onSessionReady
    })
}
