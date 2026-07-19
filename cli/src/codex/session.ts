import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { EnhancedMode, PermissionMode } from './loop';
import type { CodexCliOverrides } from './utils/codexCliOverrides';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class CodexSession extends AgentSessionBase<EnhancedMode> {
    readonly codexArgs?: string[];
    readonly codexCliOverrides?: CodexCliOverrides;
    readonly codexEnvVars?: Record<string, string>;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    readonly forkFromSessionId?: string;
    readonly forkAtTimestamp?: string;
    localLaunchFailure: LocalLaunchFailure | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<EnhancedMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        codexArgs?: string[];
        codexCliOverrides?: CodexCliOverrides;
        codexEnvVars?: Record<string, string>;
        forkFromSessionId?: string;
        forkAtTimestamp?: string;
        permissionMode?: PermissionMode;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'CodexSession',
            sessionIdLabel: 'Codex',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                codexSessionId: sessionId
            }),
            permissionMode: opts.permissionMode
        });

        this.codexArgs = opts.codexArgs;
        this.codexCliOverrides = opts.codexCliOverrides;
        this.codexEnvVars = opts.codexEnvVars;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.forkFromSessionId = opts.forkFromSessionId;
        this.forkAtTimestamp = opts.forkAtTimestamp;
        this.permissionMode = opts.permissionMode;

        // If a Codex session is being resumed, immediately apply its thread id.
        // Native forks start without one and publish the new id after thread/fork.
        if (opts.sessionId) {
            this.onSessionFound(opts.sessionId);
        }
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModelMode = (mode: string | undefined): void => {
        this.modelMode = mode as typeof this.modelMode;
    };

    setEffortMode = (mode: string | undefined): void => {
        this.effortMode = (mode && mode !== 'default' ? mode : 'default') as import('@hapi/protocol/types').EffortMode;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendCodexMessage = (message: unknown): void => {
        this.client.sendCodexMessage(message);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
