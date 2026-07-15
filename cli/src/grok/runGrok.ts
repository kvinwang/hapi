import { logger } from '@/ui/logger';
import { grokLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { GrokSession } from './session';
import type { GrokMode, PermissionMode } from './types';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { resolveGrokRuntimeConfig } from './utils/config';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';

function mapGrokEffort(value: string): GrokMode['effort'] {
    const v = value.trim().toLowerCase();
    if (!v || v === 'default') {
        return undefined;
    }
    if (v === 'low' || v === 'medium' || v === 'high') {
        return v;
    }
    if (v === 'xhigh' || v === 'max' || v === 'auto') {
        return 'high';
    }
    throw new Error('Invalid effort mode for Grok');
}

export async function runGrok(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    resumeSessionId?: string;
    forkFromSessionId?: string;
} = {}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[grok] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[grok] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    const { api, session } = await bootstrapSession({
        flavor: 'grok',
        startedBy,
        workingDirectory,
        agentState: initialState
    });

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<GrokMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
        appendSystemPrompt: mode.appendSystemPrompt
    }));

    const sessionWrapperRef: { current: GrokSession | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel: string = resolveGrokRuntimeConfig({ model: opts.model }).model;
    let currentEffort: GrokMode['effort'];
    let currentAppendSystemPrompt: string | undefined;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'grok',
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
        sessionInstance.setEffortMode?.(currentEffort ?? 'default');
        logger.debug(`[grok] Synced session modes: permission=${currentPermissionMode}, model=${currentModel}, effort=${currentEffort ?? 'default'}`);
    };

    session.onUserMessage((message) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        // Prefer modelMode/effortMode/appendSystemPrompt from message meta (hub-applied) when present.
        let model = currentModel;
        if (message.meta && typeof message.meta === 'object') {
            const meta = message.meta as {
                modelMode?: unknown
                effortMode?: unknown
                appendSystemPrompt?: unknown
            };
            if (typeof meta.modelMode === 'string' && meta.modelMode.trim() && meta.modelMode !== 'auto') {
                model = meta.modelMode.trim();
                currentModel = model;
            }
            if (typeof meta.effortMode === 'string') {
                currentEffort = mapGrokEffort(meta.effortMode);
            }
            // Hub always attaches appendSystemPrompt (session + global + HAPI built-in).
            // Treat explicit null as "clear override" → undefined.
            if (Object.prototype.hasOwnProperty.call(meta, 'appendSystemPrompt')) {
                const raw = meta.appendSystemPrompt;
                currentAppendSystemPrompt = typeof raw === 'string' && raw.trim().length > 0
                    ? raw
                    : undefined;
            }
        }
        const mode: GrokMode = {
            permissionMode: currentPermissionMode,
            model,
            effort: currentEffort,
            appendSystemPrompt: currentAppendSystemPrompt
        };
        messageQueue.push(formattedText, mode);
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'grok')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveModelMode = (value: unknown): string => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error('Invalid model mode');
        }
        const trimmed = value.trim();
        if (trimmed === 'auto' || trimmed === 'default') {
            return resolveGrokRuntimeConfig({}).model;
        }
        return trimmed;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; modelMode?: unknown; effortMode?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }
        if (config.modelMode !== undefined) {
            currentModel = resolveModelMode(config.modelMode);
        }
        if (config.effortMode !== undefined) {
            if (typeof config.effortMode !== 'string') {
                throw new Error('Invalid effort mode');
            }
            currentEffort = mapGrokEffort(config.effortMode);
        }

        syncSessionMode();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                modelMode: currentModel,
                effortMode: currentEffort ?? 'default'
            }
        };
    });

    try {
        await grokLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: currentModel,
            resumeSessionId: opts.forkFromSessionId ? undefined : opts.resumeSessionId,
            forkFromSessionId: opts.forkFromSessionId,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        lifecycle.markCrash(error);
        logger.debug('[grok] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
