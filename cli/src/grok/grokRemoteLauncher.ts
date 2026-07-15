import React from 'react';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { GrokDisplay } from '@/ui/ink/GrokDisplay';
import type { GrokSession } from './session';
import type { PermissionMode } from './types';
import { createGrokBackend } from './utils/grokBackend';
import { GrokPermissionHandler } from './utils/permissionHandler';
import { resolveGrokRuntimeConfig } from './utils/config';

class GrokRemoteLauncher extends RemoteLauncherBase {
    private readonly session: GrokSession;
    private readonly initialModel?: string;
    private readonly forkFromSessionId?: string;
    private backend: ReturnType<typeof createGrokBackend> | null = null;
    private permissionHandler: GrokPermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayModel: string | null = null;
    private displayPermissionMode: PermissionMode | null = null;
    private activeModel: string | null = null;
    /** Last rules string applied via session/new `_meta.rules`. */
    private appliedRules: string | undefined;
    /**
     * When true, the current ACP session was resumed/forked and must not be
     * recreated just to inject rules (that would drop agent history). Rules
     * are only applied on the next explicit session reset (/clear or prompt change
     * after a fresh newSession).
     */
    private preserveResumedSession = false;

    constructor(session: GrokSession, opts: { model?: string; forkFromSessionId?: string }) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.initialModel = opts.model;
        this.forkFromSessionId = opts.forkFromSessionId;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(GrokDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        const runtimeConfig = resolveGrokRuntimeConfig({
            model: session.getModelMode() ?? this.initialModel
        });
        this.displayModel = runtimeConfig.model;
        this.activeModel = runtimeConfig.model;
        messageBuffer.addMessage(`[MODEL:${runtimeConfig.model}]`, 'system');
        this.updateResolvedModel(runtimeConfig.model);

        const backend = createGrokBackend({
            model: runtimeConfig.model,
            cwd: session.path,
            permissionMode: session.getPermissionMode() as string | undefined
        });
        this.backend = backend;

        backend.onStderrError((error) => {
            logger.debug('[grok-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();
        // Catalog may already be available from initialize _meta.modelState
        this.syncModelCatalogToMetadata(backend, runtimeConfig.model);

        const resumeSessionId = session.sessionId;
        const acpMcpServers = toAcpMcpServers(mcpServers);
        // Lazy-create for brand-new sessions so the first hub message can attach
        // `_meta.rules` (system prompt). Resume/fork still establish an ACP session now.
        let acpSessionId: string | null = null;
        this.appliedRules = undefined;

        if (this.forkFromSessionId) {
            try {
                acpSessionId = await backend.forkSession({
                    sourceSessionId: this.forkFromSessionId,
                    sourceCwd: session.path,
                    newCwd: session.path,
                    mcpServers: acpMcpServers
                });
                this.preserveResumedSession = true;
                messageBuffer.addMessage(
                    `Forked Grok agent session from ${this.forkFromSessionId.slice(0, 8)}…`,
                    'status'
                );
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Grok agent history forked into this session.'
                });
            } catch (error) {
                logger.warn('[grok-remote] ACP fork failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Grok agent fork failed; starting a fresh agent session (chat history still in HAPI).'
                });
                // Leave acpSessionId null — first message will create with rules.
            }
        } else if (resumeSessionId) {
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: resumeSessionId,
                    cwd: session.path,
                    mcpServers: acpMcpServers
                });
                this.preserveResumedSession = true;
            } catch (error) {
                logger.warn('[grok-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Grok resume failed; starting a new session.'
                });
            }
        }

        if (acpSessionId) {
            session.onSessionFound(acpSessionId);
        }
        this.syncModelCatalogToMetadata(backend, backend.getCurrentModelId() ?? runtimeConfig.model);

        this.permissionHandler = new GrokPermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        this.applyDisplayMode(
            session.getPermissionMode() as PermissionMode,
            backend.getCurrentModelId() ?? runtimeConfig.model
        );

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const batch = await session.queue.waitForMessagesAndGetAsString(this.abortController.signal);
            if (!batch) {
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            const nextRules = batch.mode.appendSystemPrompt;

            if (batch.message.trim() === '/clear') {
                logger.debug('[Grok] /clear command received – resetting session');
                messageBuffer.addMessage('Context was reset', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: toAcpMcpServers(mcpServers),
                    rules: nextRules
                });
                this.appliedRules = nextRules;
                this.preserveResumedSession = false;
                session.onSessionFound(acpSessionId);
                continue;
            }

            this.applyDisplayMode(batch.mode.permissionMode, batch.mode.model);
            messageBuffer.addMessage(batch.message, 'user');

            // Apply system prompt via ACP session/new `_meta.rules` (session-scoped only).
            // - No ACP session yet → create with rules
            // - Rules changed after a fresh session → recreate
            // - Resumed/forked sessions: keep agent history; adopt rules marker without recreate
            if (!acpSessionId) {
                logger.debug('[grok-remote] Creating ACP session with system prompt rules', {
                    rulesLen: nextRules?.length ?? 0
                });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: toAcpMcpServers(mcpServers),
                    rules: nextRules
                });
                this.appliedRules = nextRules;
                this.preserveResumedSession = false;
                session.onSessionFound(acpSessionId);
                if (nextRules) {
                    messageBuffer.addMessage('System prompt applied.', 'status');
                }
            } else if (nextRules !== this.appliedRules) {
                if (this.preserveResumedSession && this.appliedRules === undefined) {
                    // First message after resume/fork: keep history; rules were not in the original session.
                    logger.debug('[grok-remote] Keeping resumed/forked ACP session; system prompt rules not re-injected');
                    this.appliedRules = nextRules;
                    this.preserveResumedSession = false;
                } else {
                    logger.debug('[grok-remote] Recreating ACP session for system prompt change', {
                        rulesLen: nextRules?.length ?? 0
                    });
                    acpSessionId = await backend.newSession({
                        cwd: session.path,
                        mcpServers: toAcpMcpServers(mcpServers),
                        rules: nextRules
                    });
                    this.appliedRules = nextRules;
                    this.preserveResumedSession = false;
                    session.onSessionFound(acpSessionId);
                    messageBuffer.addMessage('System prompt updated (new agent session).', 'status');
                }
            }

            // Apply mid-session model switch when the web UI changes modelMode.
            if (batch.mode.model && batch.mode.model !== this.activeModel) {
                await this.applyModelChange(acpSessionId, batch.mode.model);
            }
            if (batch.mode.effort) {
                await this.applyEffortChange(acpSessionId, batch.mode.effort);
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn('[grok-remote] prompt failed', { message: errorMessage });
                session.sendSessionEvent({
                    type: 'message',
                    message: `Grok prompt failed: ${errorMessage}`
                });
                messageBuffer.addMessage(`Grok prompt failed: ${errorMessage}`, 'status');
            } finally {
                session.onThinkingChange(false);
                await this.permissionHandler?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.permissionHandler) {
            await this.permissionHandler.cancelAll('Session ended');
            this.permissionHandler = null;
        }

        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message);
        if (converted) {
            this.session.sendCodexMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'turn_complete':
                if (message.usage?.modelId) {
                    this.updateResolvedModel(message.usage.modelId);
                    this.applyDisplayMode(undefined, message.usage.modelId);
                }
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined, model?: string): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
        if (model && model !== this.displayModel) {
            this.displayModel = model;
            this.messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
        }
    }

    private updateResolvedModel(model: string, contextWindowTokens?: number): void {
        const normalized = model.trim();
        if (!normalized) {
            return;
        }
        this.activeModel = normalized;
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            resolvedModel: normalized,
            resolvedModelProvider: 'grok',
            resolvedModelAt: Date.now(),
            ...(typeof contextWindowTokens === 'number' && contextWindowTokens > 0
                ? { contextWindowTokens }
                : {})
        }));
    }

    private syncModelCatalogToMetadata(
        backend: ReturnType<typeof createGrokBackend>,
        preferredModel?: string | null
    ): void {
        const catalog = backend.getModelCatalog();
        const currentId = preferredModel ?? backend.getCurrentModelId();
        const windowTokens = backend.getContextWindowTokens(currentId);
        if (currentId) {
            this.activeModel = currentId;
            this.displayModel = currentId;
        }
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            ...(currentId
                ? {
                    resolvedModel: currentId,
                    resolvedModelProvider: 'grok',
                    resolvedModelAt: Date.now()
                }
                : {}),
            ...(typeof windowTokens === 'number' && windowTokens > 0
                ? { contextWindowTokens: windowTokens }
                : {}),
            ...(catalog.length > 0
                ? {
                    agentModelCatalog: catalog.map((entry) => ({
                        id: entry.id,
                        name: entry.name,
                        description: entry.description,
                        contextWindowTokens: entry.contextWindowTokens
                    }))
                }
                : {})
        }));
    }

    private async applyModelChange(sessionId: string, model: string): Promise<void> {
        const backend = this.backend;
        if (!backend) {
            return;
        }
        const target = model.trim();
        if (!target || target === this.activeModel) {
            return;
        }
        try {
            const applied = await backend.setModel(sessionId, target);
            const windowTokens = backend.getContextWindowTokens(applied || target);
            this.updateResolvedModel(applied || target, windowTokens);
            this.syncModelCatalogToMetadata(backend, applied || target);
            this.applyDisplayMode(undefined, applied || target);
            this.messageBuffer.addMessage(`Model switched to ${applied || target}`, 'status');
            this.session.sendSessionEvent({
                type: 'message',
                message: `Model switched to ${applied || target}`
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.warn('[grok-remote] set_model failed', { model: target, error: errMsg });
            this.messageBuffer.addMessage(`Model switch failed: ${errMsg}`, 'status');
            this.session.sendSessionEvent({
                type: 'message',
                message: `Grok model switch failed: ${errMsg}`
            });
        }
    }

    private async applyEffortChange(sessionId: string, effort: string): Promise<void> {
        const backend = this.backend;
        if (!backend) {
            return;
        }
        const modeId = effort.trim().toLowerCase();
        if (!modeId || modeId === 'default') {
            return;
        }
        try {
            await backend.setMode(sessionId, modeId);
            this.messageBuffer.addMessage(`Effort set to ${modeId}`, 'status');
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.warn('[grok-remote] set_mode (effort) failed', { effort: modeId, error: errMsg });
            this.messageBuffer.addMessage(`Effort switch failed: ${errMsg}`, 'status');
        }
    }

    private async handleAbort(): Promise<void> {
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            await backend.cancelPrompt(this.session.sessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
        this.session.sendSessionEvent({ type: 'message', message: 'Session aborted' });
        this.session.queue.reset();
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }));
}

export async function grokRemoteLauncher(
    session: GrokSession,
    opts: { model?: string; forkFromSessionId?: string }
): Promise<'switch' | 'exit'> {
    const launcher = new GrokRemoteLauncher(session, opts);
    return launcher.launch();
}
