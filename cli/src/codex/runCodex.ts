import { CodexProviderRequestSchema, prepareSessionProvider, listSessionProfiles, parseCodexProfileArgs } from './utils/sessionProvider';
import { mapCodexEffort } from './utils/codexEffort';
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
    session.updateMetadata((metadata) => ({ ...metadata, codexProvider: undefined }));

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
        collaborationMode: mode.collaborationMode
        // appendSystemPrompt is intentionally excluded: prompt edits must not
        // restart a running Codex session.
    }));

    const nativeProfile = parseCodexProfileArgs(opts.codexArgs);
    const codexCliOverrides = parseCodexCliOverrides(nativeProfile.args);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel: string | undefined = opts.model;
    let currentEffort: EnhancedMode['effort'];
    let currentCollaborationMode: EnhancedMode['collaborationMode'];
    let currentAppendSystemPrompt: string | undefined;

    const providerHomes: Array<() => Promise<void>> = [];
    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'codex',
        onAfterClose: async () => { await Promise.all(providerHomes.map((dispose) => dispose().catch(() => {}))); },
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

    const deferredProviderMessages: Array<() => void> = [];
    const handleUserMessage = (message: Parameters<Parameters<typeof session.onUserMessage>[0]>[0]) => {
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

        if (sessionWrapperRef.current) sessionWrapperRef.current.appendSystemPrompt = messageAppendSystemPrompt;
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModel,
            effort: currentEffort,
            collaborationMode: currentCollaborationMode,
            appendSystemPrompt: messageAppendSystemPrompt
        };
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, enhancedMode);
    };
    session.onUserMessage((message) => {
        if (sessionWrapperRef.current?.providerChanging) {
            deferredProviderMessages.push(() => handleUserMessage(message));
        } else {
            handleUserMessage(message);
        }
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
        if (sessionWrapperRef.current?.providerChanging) throw new Error('Provider switch in progress');
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

    const defaultEnv = { HAPI_SESSION_ID: sessionInfo.id };
    session.rpcHandlerManager.registerHandler('list-session-profiles', async () => ({ profiles: await listSessionProfiles() }));
    session.rpcHandlerManager.registerHandler('set-session-provider', async (payload: unknown) => {
        const parsed = CodexProviderRequestSchema.safeParse(payload);
        if (!parsed.success) throw new Error('Invalid provider selection');
        const instance = sessionWrapperRef.current;
        if (!instance || instance.mode !== 'remote' || !instance.restartForProvider || process.env.CODEX_USE_MCP_SERVER === '1') {
            throw new Error('Provider switching requires remote Codex app-server mode');
        }
        if (instance.providerChanging || instance.thinking || messageQueue.size() > 0) {
            throw new Error('Wait until the Codex session is idle');
        }
        instance.providerChanging = true;
        const previousEnv = instance.codexEnvVars;
        const previousConfig = instance.providerConfig;
        const previousProfile = instance.providerProfile;
        const previousModel = currentModel;
        let prepared: Awaited<ReturnType<typeof prepareSessionProvider>> = null;
        let stage: 'prepare' | 'restart' = 'prepare';
        try {
            prepared = await prepareSessionProvider(parsed.data);
            if (prepared?.dispose) providerHomes.push(prepared.dispose);
            instance.codexEnvVars = prepared?.home
                ? { ...defaultEnv, CODEX_HOME: prepared.home, HAPI_CODEX_ISOLATED_PROVIDER: '1' }
                : defaultEnv;
            instance.providerConfig = prepared?.config;
            instance.providerProfile = prepared?.profile;
            instance.requireProviderResume = true;
            const model = resolveModelMode(parsed.data.model);
            instance.setModelMode(model);
            stage = 'restart';
            await instance.restartForProvider();
            currentModel = model;
            session.updateMetadata((metadata) => ({
                ...metadata,
                codexProvider: { provider: parsed.data.provider, name: parsed.data.name },
                resolvedModel: undefined,
                contextWindowTokens: undefined
            }));
            syncSessionMode();
            return { applied: { modelMode: model ?? 'auto' } };
        } catch {
            instance.codexEnvVars = previousEnv;
            instance.providerConfig = previousConfig;
            instance.providerProfile = previousProfile;
            instance.setModelMode(previousModel);
            await prepared?.dispose?.().catch(() => {});
            return { providerSwitchError: stage === 'prepare' ? 'prepare_failed' : 'restart_failed' };
        } finally {
            instance.providerChanging = false;
            for (const deliver of deferredProviderMessages.splice(0)) deliver();
        }
    });

    try {
        if (nativeProfile.profile && process.env.CODEX_USE_MCP_SERVER === '1') {
            throw new Error('Codex profiles require app-server mode for remote control');
        }
        const initialProvider = nativeProfile.profile ? await prepareSessionProvider({
            provider: { source: 'profile', profile: nativeProfile.profile }, name: nativeProfile.profile, model: 'auto'
        }) : null;
        if (initialProvider) {
            if (initialProvider.dispose) providerHomes.push(initialProvider.dispose);
            if (!opts.model && typeof initialProvider.config.model === 'string') currentModel = initialProvider.config.model;
            session.updateMetadata((metadata) => ({ ...metadata,
                codexProvider: { provider: { source: 'profile', profile: nativeProfile.profile! }, name: nativeProfile.profile! }
            }));
        }
        await loop({
            path: workingDirectory,
            startingMode,
            messageQueue,
            api,
            session,
            codexArgs: nativeProfile.args,
            providerConfig: initialProvider?.config,
            providerProfile: initialProvider?.profile,
            codexCliOverrides,
            startedBy,
            permissionMode: currentPermissionMode,
            codexEnvVars: { HAPI_SESSION_ID: sessionInfo.id, ...(initialProvider?.home ? { CODEX_HOME: initialProvider.home, HAPI_CODEX_ISOLATED_PROVIDER: '1' } : {}) },
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
