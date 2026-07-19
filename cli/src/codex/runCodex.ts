import { logger } from '@/ui/logger';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CodexSession } from './session';
import { parseCodexCliOverrides } from './utils/codexCliOverrides';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

function mapCodexEffort(value: string): EnhancedMode['effort'] {
    const v = value.trim().toLowerCase();
    if (!v || v === 'default') {
        return undefined;
    }
    if (v === 'auto' || v === 'low' || v === 'medium' || v === 'high') {
        return v;
    }
    // Claude-style levels map onto Codex high.
    if (v === 'xhigh' || v === 'max') {
        return 'high';
    }
    throw new Error('Invalid effort mode for Codex');
}

export async function runCodex(opts: {
    startedBy?: 'runner' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    forkFromSessionId?: string;
    forkAtTimestamp?: string;
    model?: string;
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

    let state: AgentState = {
        controlledByUser: false
    };
    const { api, session, sessionInfo } = await bootstrapSession({
        flavor: 'codex',
        startedBy,
        workingDirectory,
        agentState: state
    });

    const startingMode: 'local' | 'remote' = startedBy === 'runner' ? 'remote' : 'local';

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
        collaborationMode: mode.collaborationMode,
        appendSystemPrompt: mode.appendSystemPrompt
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel: string | undefined = opts.model;
    let currentEffort: EnhancedMode['effort'];
    let currentCollaborationMode: EnhancedMode['collaborationMode'];
    let currentAppendSystemPrompt: string | undefined;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'codex',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModelMode(currentModel);
        sessionInstance.setEffortMode(currentEffort ?? 'default');
        sessionInstance.publishRuntimeState();
        logger.debug(`[Codex] Synced modes: permission=${currentPermissionMode}, model=${currentModel ?? 'auto'}, effort=${currentEffort ?? 'default'}`);
    };

    session.onUserMessage((message) => {
        const messagePermissionMode = currentPermissionMode;
        logger.debug(`[Codex] User message received with permission mode: ${currentPermissionMode}`);

        if (message.meta && typeof message.meta === 'object') {
            const meta = message.meta as Record<string, unknown>;
            if (typeof meta.modelMode === 'string' && meta.modelMode.trim() && meta.modelMode !== 'auto' && meta.modelMode !== 'default') {
                currentModel = meta.modelMode.trim();
            }
            if (typeof meta.effortMode === 'string') {
                currentEffort = mapCodexEffort(meta.effortMode);
            }
        }

        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
            currentAppendSystemPrompt = messageAppendSystemPrompt;
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModel,
            effort: currentEffort,
            collaborationMode: currentCollaborationMode,
            appendSystemPrompt: messageAppendSystemPrompt
        };
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, enhancedMode);
    });

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'codex')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveCollaborationMode = (value: unknown): EnhancedMode['collaborationMode'] => {
        if (value === null) {
            return undefined;
        }
        if (typeof value !== 'string') {
            throw new Error('Invalid collaboration mode');
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error('Invalid collaboration mode');
        }
        return trimmed as EnhancedMode['collaborationMode'];
    };

    const resolveModelMode = (value: unknown): string | undefined => {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error('Invalid model mode');
        }
        const trimmed = value.trim();
        if (trimmed === 'auto' || trimmed === 'default') {
            return undefined;
        }
        return trimmed;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as {
            permissionMode?: unknown;
            collaborationMode?: unknown;
            modelMode?: unknown;
            effortMode?: unknown;
        };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.collaborationMode !== undefined) {
            currentCollaborationMode = resolveCollaborationMode(config.collaborationMode);
        }

        if (config.modelMode !== undefined) {
            currentModel = resolveModelMode(config.modelMode);
        }

        if (config.effortMode !== undefined) {
            if (typeof config.effortMode !== 'string') {
                throw new Error('Invalid effort mode');
            }
            currentEffort = mapCodexEffort(config.effortMode);
        }

        syncSessionMode();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                collaborationMode: currentCollaborationMode,
                modelMode: currentModel ?? 'auto',
                effortMode: currentEffort ?? 'default'
            }
        };
    });

    try {
        await loop({
            path: workingDirectory,
            startingMode,
            messageQueue,
            api,
            session,
            codexArgs: opts.codexArgs,
            codexCliOverrides,
            startedBy,
            permissionMode: currentPermissionMode,
            codexEnvVars: { HAPI_SESSION_ID: sessionInfo.id },
            resumeSessionId: opts.resumeSessionId,
            forkFromSessionId: opts.forkFromSessionId,
            forkAtTimestamp: opts.forkAtTimestamp,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        lifecycle.markCrash(error);
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${formatFailureReason(localFailure.message)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
