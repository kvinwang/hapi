import { MessageQueue2 } from '@/utils/MessageQueue2';
import { runLocalRemoteSession } from '@/agent/loopBase';
import { GrokSession } from './session';
import { grokLocalLauncher } from './grokLocalLauncher';
import { grokRemoteLauncher } from './grokRemoteLauncher';
import { ApiClient, ApiSessionClient } from '@/lib';
import type { GrokMode, PermissionMode } from './types';
import { logger } from '@/ui/logger';

interface GrokLoopOptions {
    path: string;
    startingMode?: 'local' | 'remote';
    startedBy?: 'runner' | 'terminal';
    onModeChange: (mode: 'local' | 'remote') => void;
    messageQueue: MessageQueue2<GrokMode>;
    session: ApiSessionClient;
    api: ApiClient;
    permissionMode?: PermissionMode;
    model?: string;
    resumeSessionId?: string;
    /** Source Grok ACP session to fork (full agent history). */
    forkFromSessionId?: string;
    onSessionReady?: (session: GrokSession) => void;
}

export async function grokLoop(opts: GrokLoopOptions): Promise<void> {
    const logPath = logger.getLogPath();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode = opts.startingMode ?? 'local';

    // Fork creates a new ACP session id — do not pre-seed resumeSessionId.
    const initialSessionId = opts.forkFromSessionId ? null : (opts.resumeSessionId ?? null);

    const session = new GrokSession({
        api: opts.api,
        client: opts.session,
        path: opts.path,
        sessionId: initialSessionId,
        logPath,
        messageQueue: opts.messageQueue,
        onModeChange: opts.onModeChange,
        mode: startingMode,
        startedBy,
        startingMode,
        permissionMode: opts.permissionMode ?? 'default',
        modelMode: opts.model
    });

    if (initialSessionId) {
        session.onSessionFound(initialSessionId);
    }

    await runLocalRemoteSession({
        session,
        startingMode: opts.startingMode,
        logTag: 'grok-loop',
        runLocal: (instance) => grokLocalLauncher(instance, {
            model: opts.model
        }),
        runRemote: (instance) => grokRemoteLauncher(instance, {
            model: opts.model,
            forkFromSessionId: opts.forkFromSessionId
        }),
        onSessionReady: opts.onSessionReady
    });
}
