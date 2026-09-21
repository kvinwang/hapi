import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher'
import { piLocal } from './piLocal'
import type { PiSession } from './session'

export async function piLocalLauncher(session: PiSession, opts: { model?: string }): Promise<'switch' | 'exit'> {
    return new BaseLocalLauncher({
        label: 'pi-local', failureLabel: 'Local Pi process failed', queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager, startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: (abort) => piLocal({ path: session.path, sessionId: session.sessionId, model: opts.model, abort }),
        onBeforeAbortOrSwitch: () => session.onThinkingChange(false),
        sendFailureMessage: (message) => session.sendSessionEvent({ type: 'message', message }),
        recordLocalLaunchFailure: (message, reason) => session.recordLocalLaunchFailure(message, reason)
    }).run()
}
