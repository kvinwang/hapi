import type { AgentBackend, AgentMessage, AgentModelInfo, AgentSessionConfig, AgentUsage, McpServerStdio, PermissionRequest, PermissionResponse, PromptContent } from '@/agent/types';
import { asString, isObject } from '@hapi/protocol';
import { AcpStdioTransport, type AcpStderrError } from './AcpStdioTransport';
import { AcpMessageHandler } from './AcpMessageHandler';
import { logger } from '@/ui/logger';
import { withRetry } from '@/utils/time';
import packageJson from '../../../../package.json';

type PendingPermission = {
    resolve: (result: { outcome: { outcome: string; optionId?: string } }) => void;
};

export class AcpSdkBackend implements AgentBackend {
    private transport: AcpStdioTransport | null = null;
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;
    private stderrErrorHandler: ((error: AcpStderrError) => void) | null = null;
    private readonly pendingPermissions = new Map<string, PendingPermission>();
    private messageHandler: AcpMessageHandler | null = null;
    private activeSessionId: string | null = null;
    private isProcessingMessage = false;
    private responseCompleteResolvers: Array<() => void> = [];
    private lastSessionUpdateAt = 0;
    private lastModelCatalog: AgentModelInfo[] = [];
    private lastCurrentModelId: string | null = null;

    /** Retry configuration for ACP initialization */
    private static readonly INIT_RETRY_OPTIONS = {
        maxAttempts: 3,
        minDelay: 1000,
        maxDelay: 5000
    };
    private static readonly UPDATE_QUIET_PERIOD_MS = 120;
    private static readonly UPDATE_DRAIN_TIMEOUT_MS = 2000;
    private static readonly PRE_PROMPT_UPDATE_QUIET_PERIOD_MS = 200;
    private static readonly PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS = 1200;

    constructor(private readonly options: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        /**
         * ACP auth method to call after initialize.
         * - string: use that methodId (e.g. `cached_token`)
         * - `auto`: use `_meta.defaultAuthMethodId` or the first `authMethods` entry
         * - omit: skip authenticate (Gemini/OpenCode style)
         */
        authMethodId?: string | 'auto';
    }) {}

    async initialize(): Promise<void> {
        if (this.transport) return;

        this.transport = new AcpStdioTransport({
            command: this.options.command,
            args: this.options.args,
            env: this.options.env
        });

        this.transport.onNotification((method, params) => {
            this.handleNotification(method, params);
        });

        this.transport.onStderrError((error) => {
            this.stderrErrorHandler?.(error);
        });

        this.transport.registerRequestHandler('session/request_permission', async (params, requestId) => {
            return await this.handlePermissionRequest(params, requestId);
        });

        const response = await withRetry(
            () => this.transport!.sendRequest('initialize', {
                protocolVersion: 1,
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false
                },
                clientInfo: {
                    name: 'hapi',
                    version: packageJson.version
                }
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] Initialize attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        if (!isObject(response) || typeof response.protocolVersion !== 'number') {
            throw new Error('Invalid initialize response from ACP agent');
        }

        logger.debug(`[ACP] Initialized with protocol version ${response.protocolVersion}`);
        this.ingestModelsFromPayload(response);

        const authMethodId = this.resolveAuthMethodId(response);
        if (authMethodId) {
            await withRetry(
                () => this.transport!.sendRequest('authenticate', { methodId: authMethodId }),
                {
                    ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                    onRetry: (error, attempt, nextDelayMs) => {
                        logger.debug(`[ACP] authenticate(${authMethodId}) attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                    }
                }
            );
            logger.debug(`[ACP] Authenticated with method ${authMethodId}`);
        }
    }

    getModelCatalog(): AgentModelInfo[] {
        return this.lastModelCatalog.slice();
    }

    getCurrentModelId(): string | null {
        return this.lastCurrentModelId;
    }

    getContextWindowTokens(modelId?: string | null): number | undefined {
        const id = modelId ?? this.lastCurrentModelId;
        if (!id) {
            return undefined;
        }
        return this.lastModelCatalog.find((entry) => entry.id === id)?.contextWindowTokens;
    }

    private resolveAuthMethodId(initializeResponse: Record<string, unknown>): string | null {
        const configured = this.options.authMethodId;
        if (!configured) {
            return null;
        }
        if (configured !== 'auto') {
            return configured;
        }

        const meta = isObject(initializeResponse._meta) ? initializeResponse._meta : null;
        const defaultId = meta ? asString(meta.defaultAuthMethodId) : null;
        if (defaultId) {
            return defaultId;
        }

        const authMethods = initializeResponse.authMethods;
        if (Array.isArray(authMethods) && authMethods.length > 0) {
            const first = authMethods[0];
            if (isObject(first)) {
                return asString(first.id) ?? asString(first.methodId);
            }
        }
        return null;
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/new', {
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/new attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const sessionId = isObject(response) ? asString(response.sessionId) : null;
        if (!sessionId) {
            throw new Error('Invalid session/new response from ACP agent');
        }

        if (isObject(response)) {
            this.ingestModelsFromPayload(response);
        }
        this.activeSessionId = sessionId;
        return sessionId;
    }

    async loadSession(config: AgentSessionConfig & { sessionId: string }): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await withRetry(
            () => this.transport!.sendRequest('session/load', {
                sessionId: config.sessionId,
                cwd: config.cwd,
                mcpServers: config.mcpServers
            }),
            {
                ...AcpSdkBackend.INIT_RETRY_OPTIONS,
                onRetry: (error, attempt, nextDelayMs) => {
                    logger.debug(`[ACP] session/load attempt ${attempt} failed, retrying in ${nextDelayMs}ms`, error);
                }
            }
        );

        const loadedSessionId = isObject(response) ? asString(response.sessionId) : null;
        const sessionId = loadedSessionId ?? config.sessionId;
        if (isObject(response)) {
            this.ingestModelsFromPayload(response);
        }
        this.activeSessionId = sessionId;
        return sessionId;
    }

    /**
     * Grok ACP extension: fork an existing session into a new one with full agent history.
     * Method: `_x.ai/session/fork`
     */
    async forkSession(opts: {
        sourceSessionId: string;
        sourceCwd: string;
        newCwd: string;
        mcpServers: McpServerStdio[];
    }): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        const response = await this.transport.sendRequest('_x.ai/session/fork', {
            sourceSessionId: opts.sourceSessionId,
            sourceCwd: opts.sourceCwd,
            newCwd: opts.newCwd,
            mcpServers: opts.mcpServers
        });

        if (!isObject(response)) {
            throw new Error('Invalid fork response from ACP agent');
        }

        const newSessionId = asString(response.newSessionId) ?? asString(response.sessionId);
        if (!newSessionId) {
            throw new Error('Fork response missing newSessionId');
        }

        this.ingestModelsFromPayload(response);
        this.activeSessionId = newSessionId;
        logger.debug(`[ACP] Forked session ${opts.sourceSessionId} -> ${newSessionId}`, {
            chatMessagesCopied: response.chatMessagesCopied,
            updatesCopied: response.updatesCopied
        });
        return newSessionId;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }

        this.activeSessionId = sessionId;
        await this.waitForSessionUpdateQuiet(
            AcpSdkBackend.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            AcpSdkBackend.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
        );
        this.messageHandler?.flushText();
        this.messageHandler = null;
        await this.waitForSessionUpdateQuiet(
            AcpSdkBackend.PRE_PROMPT_UPDATE_QUIET_PERIOD_MS,
            AcpSdkBackend.PRE_PROMPT_UPDATE_DRAIN_TIMEOUT_MS
        );
        this.messageHandler = new AcpMessageHandler(onUpdate);
        this.isProcessingMessage = true;
        this.lastSessionUpdateAt = Date.now();
        let stopReason: string | null = null;
        let usage: AgentUsage | undefined;

        try {
            // No timeout for prompt requests - they can run for extended periods
            // during complex tasks, tool-heavy operations, or slow model responses
            const response = await this.transport.sendRequest('session/prompt', {
                sessionId,
                prompt: content
            }, { timeoutMs: Infinity });

            if (isObject(response)) {
                stopReason = asString(response.stopReason);
                usage = extractAcpUsage(response);
            }
        } finally {
            await this.waitForSessionUpdateQuiet(
                AcpSdkBackend.UPDATE_QUIET_PERIOD_MS,
                AcpSdkBackend.UPDATE_DRAIN_TIMEOUT_MS
            );
            this.messageHandler?.flushText();
            try {
                if (stopReason) {
                    onUpdate({ type: 'turn_complete', stopReason, usage });
                }
            } finally {
                this.isProcessingMessage = false;
                this.notifyResponseComplete();
            }
        }
    }

    /**
     * Switch model for an active ACP session (Grok: `session/set_model`).
     * Returns the applied model id on success.
     */
    async setModel(sessionId: string, modelId: string): Promise<string> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        const response = await this.transport.sendRequest('session/set_model', {
            sessionId,
            modelId
        });
        let applied = modelId;
        if (isObject(response) && isObject(response._meta) && isObject(response._meta.model)) {
            const modelMeta = response._meta.model as Record<string, unknown>;
            const ok = asString(modelMeta.Ok);
            if (ok) {
                applied = ok;
            }
        }
        this.lastCurrentModelId = applied;
        return applied;
    }

    /**
     * Grok ACP: `session/set_mode` — used for reasoning effort (low|medium|high).
     */
    async setMode(sessionId: string, modeId: string): Promise<void> {
        if (!this.transport) {
            throw new Error('ACP transport not initialized');
        }
        await this.transport.sendRequest('session/set_mode', {
            sessionId,
            modeId
        });
    }

    private ingestModelsFromPayload(payload: Record<string, unknown>): void {
        // session/new|load: { models: { currentModelId, availableModels } }
        // initialize: { _meta: { modelState: { ... } } }
        // _x.ai/models/update notification params: { currentModelId, availableModels }
        let modelsRoot: Record<string, unknown> | null = null;
        if (isObject(payload.models)) {
            modelsRoot = payload.models;
        } else if (isObject(payload._meta) && isObject(payload._meta.modelState)) {
            modelsRoot = payload._meta.modelState;
        } else if (Array.isArray(payload.availableModels) || typeof payload.currentModelId === 'string') {
            modelsRoot = payload;
        }

        if (!modelsRoot) {
            return;
        }

        const currentId = asString(modelsRoot.currentModelId);
        if (currentId) {
            this.lastCurrentModelId = currentId;
        }

        const available = modelsRoot.availableModels;
        if (!Array.isArray(available)) {
            return;
        }

        const catalog: AgentModelInfo[] = [];
        for (const entry of available) {
            if (!isObject(entry)) continue;
            const id = asString(entry.modelId) ?? asString(entry.id);
            if (!id) continue;
            const meta = isObject(entry._meta) ? entry._meta : null;
            const contextWindowTokens = meta
                ? (typeof meta.totalContextTokens === 'number' && Number.isFinite(meta.totalContextTokens)
                    ? meta.totalContextTokens
                    : undefined)
                : (typeof entry.totalContextTokens === 'number' && Number.isFinite(entry.totalContextTokens)
                    ? entry.totalContextTokens
                    : undefined);
            catalog.push({
                id,
                name: asString(entry.name) ?? undefined,
                description: asString(entry.description) ?? undefined,
                contextWindowTokens
            });
        }
        if (catalog.length > 0) {
            this.lastModelCatalog = catalog;
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        if (!this.transport) {
            return;
        }

        this.transport.sendNotification('session/cancel', { sessionId });
    }

    async respondToPermission(
        _sessionId: string,
        request: PermissionRequest,
        response: PermissionResponse
    ): Promise<void> {
        const pending = this.pendingPermissions.get(request.id);
        if (!pending) {
            logger.debug('[ACP] No pending permission request for id', request.id);
            return;
        }

        this.pendingPermissions.delete(request.id);

        if (response.outcome === 'cancelled') {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
            return;
        }

        pending.resolve({
            outcome: {
                outcome: 'selected',
                optionId: response.optionId
            }
        });
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    onStderrError(handler: (error: AcpStderrError) => void): void {
        this.stderrErrorHandler = handler;
    }

    /**
     * Returns true if currently processing a message (prompt in progress).
     * Useful for checking if it's safe to perform session operations.
     */
    get processingMessage(): boolean {
        return this.isProcessingMessage;
    }

    getLastSessionUpdateAt(): number {
        return this.lastSessionUpdateAt;
    }

    /**
     * Wait for any in-progress response to complete.
     * Resolves immediately if no response is being processed.
     * Use this before performing operations that require the response to be complete,
     * like session swap or sending task_complete.
     */
    async waitForResponseComplete(): Promise<void> {
        if (!this.isProcessingMessage) {
            return;
        }
        return new Promise<void>((resolve) => {
            this.responseCompleteResolvers.push(resolve);
        });
    }

    async disconnect(): Promise<void> {
        if (!this.transport) return;
        this.messageHandler?.flushText();
        this.messageHandler = null;
        this.activeSessionId = null;
        this.isProcessingMessage = false;
        this.notifyResponseComplete();
        await this.transport.close();
        this.transport = null;
    }

    private handleSessionUpdate(params: unknown): void {
        if (!isObject(params)) return;
        const sessionId = asString(params.sessionId);
        if (this.activeSessionId && sessionId && sessionId !== this.activeSessionId) {
            return;
        }
        this.lastSessionUpdateAt = Date.now();
        const update = params.update;
        this.messageHandler?.handleUpdate(update);
    }

    /**
     * Handle non-session/update notifications (e.g. Grok `_x.ai/models/update`).
     */
    private handleNotification(method: string, params: unknown): void {
        if (method === 'session/update') {
            this.handleSessionUpdate(params);
            return;
        }
        if ((method === '_x.ai/models/update' || method === 'x.ai/models/update') && isObject(params)) {
            this.ingestModelsFromPayload(params);
        }
    }

    private async waitForSessionUpdateQuiet(quietMs: number, timeoutMs: number): Promise<void> {
        if (quietMs <= 0 || timeoutMs <= 0) {
            return;
        }

        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const elapsedSinceUpdate = Date.now() - this.lastSessionUpdateAt;
            if (elapsedSinceUpdate >= quietMs) {
                return;
            }

            const remainingToQuiet = quietMs - elapsedSinceUpdate;
            const remainingBudget = deadline - Date.now();
            const waitMs = Math.max(1, Math.min(remainingToQuiet, remainingBudget));
            await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
    }

    private async handlePermissionRequest(params: unknown, requestId: string | number | null): Promise<unknown> {
        if (!isObject(params)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        const sessionId = asString(params.sessionId) ?? this.activeSessionId ?? 'unknown';
        const toolCall = isObject(params.toolCall) ? params.toolCall : {};
        const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
        const title = asString(toolCall.title) ?? undefined;
        const kind = asString(toolCall.kind) ?? undefined;
        const rawInput = 'rawInput' in toolCall ? toolCall.rawInput : undefined;
        const rawOutput = 'rawOutput' in toolCall ? toolCall.rawOutput : undefined;
        const options = Array.isArray(params.options)
            ? params.options
                .filter((option) => isObject(option))
                .map((option, index) => ({
                    optionId: asString(option.optionId) ?? `option-${index + 1}`,
                    name: asString(option.name) ?? `Option ${index + 1}`,
                    kind: asString(option.kind) ?? 'allow_once'
                }))
            : [];

        const request: PermissionRequest = {
            id: toolCallId,
            sessionId,
            toolCallId,
            title,
            kind,
            rawInput,
            rawOutput,
            options
        };

        const responsePromise = new Promise((resolve) => {
            this.pendingPermissions.set(toolCallId, { resolve });
        });

        if (this.permissionHandler) {
            try {
                this.permissionHandler(request);
            } catch (error) {
                this.pendingPermissions.delete(toolCallId);
                throw error;
            }
        } else {
            logger.debug('[ACP] No permission handler registered; cancelling request');
            this.pendingPermissions.delete(toolCallId);
            return { outcome: { outcome: 'cancelled' } };
        }

        return await responsePromise;
    }

    private notifyResponseComplete(): void {
        const resolvers = this.responseCompleteResolvers;
        this.responseCompleteResolvers = [];
        for (const resolve of resolvers) {
            resolve();
        }
    }
}

function asFiniteNumber(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return value;
}

/**
 * Grok (and potentially other ACP agents) attach token stats on prompt result `_meta`.
 */
export function extractAcpUsage(response: Record<string, unknown>): AgentUsage | undefined {
    const meta = isObject(response._meta) ? response._meta : null;
    if (!meta) {
        return undefined;
    }

    const totalTokens = asFiniteNumber(meta.totalTokens);
    const inputTokens = asFiniteNumber(meta.inputTokens);
    const outputTokens = asFiniteNumber(meta.outputTokens) ?? 0;
    const cacheReadTokens = asFiniteNumber(meta.cachedReadTokens)
        ?? asFiniteNumber(meta.cacheReadTokens)
        ?? undefined;
    const cacheCreationTokens = asFiniteNumber(meta.cacheCreationTokens)
        ?? asFiniteNumber(meta.cachedWriteTokens)
        ?? undefined;
    const modelId = asString(meta.modelId) ?? asString(meta.model) ?? undefined;

    // Prefer totalTokens for context occupancy when present (Grok reports both).
    const resolvedInput = totalTokens ?? inputTokens;
    if (resolvedInput === null) {
        return undefined;
    }

    return {
        inputTokens: resolvedInput,
        outputTokens,
        cacheReadTokens: cacheReadTokens ?? undefined,
        cacheCreationTokens: cacheCreationTokens ?? undefined,
        totalTokens: totalTokens ?? undefined,
        modelId
    };
}
