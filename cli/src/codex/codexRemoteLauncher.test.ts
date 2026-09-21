import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';
import type { CodexSession } from './session';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    startThreadCalls: 0,
    connectHomes: [] as Array<string | undefined>,
    disconnects: 0,
    failHome: null as string | null,
    failResumeHome: null as string | null,
    failModelDiscovery: false,
    resumeThreadCalls: [] as string[],
    resumeConfigs: [] as Array<Record<string, unknown> | undefined>,
    startTurnCalls: 0,
    onStartTurn: null as null | (() => void)
}));

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        constructor(private readonly env?: Record<string, string>) {}

        async connect(): Promise<void> {
            harness.connectHomes.push(this.env?.CODEX_HOME);
            if (harness.failHome && this.env?.CODEX_HOME === harness.failHome) throw new Error('Synthetic startup failure');
        }

        async listModels() {
            if (harness.failModelDiscovery) throw new Error('model/list unavailable');
            return [{ value: 'test-codex-model', displayName: 'Test Codex Model', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra', isDefault: true }];
        }

        async initialize(): Promise<{ protocolVersion: number }> {
            return { protocolVersion: 1 };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
        }

        setStderrHandler(_handler: ((stderr: string) => void) | null): void {}

        registerRequestHandler(method: string): void {
            harness.registerRequestCalls.push(method);
        }

        async startThread(): Promise<{ thread: { id: string } }> {
            harness.startThreadCalls += 1;
            return { thread: { id: 'thread-anonymous' } };
        }

        async resumeThread(params: { threadId: string; config?: Record<string, unknown> }): Promise<{ thread: { id: string } }> {
            if (harness.failResumeHome && this.env?.CODEX_HOME === harness.failResumeHome) throw new Error('Synthetic resume failure');
            harness.resumeThreadCalls.push(params.threadId);
            harness.resumeConfigs.push(params.config);
            return { thread: { id: params.threadId } };
        }

        async startTurn(): Promise<{ turn: Record<string, never> }> {
            harness.startTurnCalls += 1;
            harness.onStartTurn?.();
            const started = { turn: {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            const completed = { status: 'Completed', turn: {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: {} };
        }

        async interruptTurn(): Promise<Record<string, never>> {
            return {};
        }

        async disconnect(): Promise<void> { harness.disconnects += 1; }
    }

    return { CodexAppServerClient: MockCodexAppServerClient };
});

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            stop: () => {}
        },
        mcpServers: {}
    })
}));

import { codexRemoteLauncher } from './codexRemoteLauncher';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMode(): EnhancedMode {
    return {
        permissionMode: 'default'
    };
}

function createSessionStub(options?: { closeQueue?: boolean }) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    queue.push('hello from launcher test', createMode());
    if (options?.closeQueue !== false) queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    let metadata: Record<string, unknown> = {};
    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        },
        updateMetadata(handler: (metadata: Record<string, unknown>) => Record<string, unknown>) { metadata = handler(metadata); },
        sendCodexMessage(message: unknown) {
            codexMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        }
    };

    const session = {
        path: '/tmp/hapi-update',
        logPath: '/tmp/hapi-update/test.log',
        client,
        queue,
        codexArgs: undefined,
        codexCliOverrides: undefined,
        sessionId: null as string | null,
        thinking: false,
        getModelMode: () => undefined,
        getPermissionMode: () => 'default',
        setModelMode: (_model: string | undefined) => {},
        onThinkingChange(nextThinking: boolean) {
            session.thinking = nextThinking;
            thinkingChanges.push(nextThinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
            foundSessionIds.push(id);
        },
        sendCodexMessage(message: unknown) {
            client.sendCodexMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(text: string) {
            client.sendUserMessage(text);
        }
    };

    return {
        session,
        sessionEvents,
        codexMessages,
        thinkingChanges,
        foundSessionIds,
        rpcHandlers,
        getMetadata: () => metadata,
        getAgentState: () => agentState
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.startThreadCalls = 0;
        harness.connectHomes = [];
        harness.disconnects = 0;
        harness.failHome = null;
        harness.failResumeHome = null;
        harness.failModelDiscovery = false;
        harness.resumeThreadCalls = [];
        harness.resumeConfigs = [];
        harness.startTurnCalls = 0;
        harness.onStartTurn = null;
        delete process.env.CODEX_USE_MCP_SERVER;
    });


    it('restarts with a profile overlay, preserves CODEX_HOME, and resumes the same thread', async () => {
        const stub = createSessionStub({ closeQueue: false });
        const session = stub.session as unknown as CodexSession;
        const launch = codexRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.startTurnCalls).toBe(1));

        session.providerConfig = { model_provider: 'provider-a', model: 'profile-model' };
        session.providerProfile = 'provider-a';
        session.requireProviderResume = true;
        await session.restartForProvider!();
        expect(harness.connectHomes).toEqual([undefined, undefined]);
        expect(harness.disconnects).toBe(1);
        expect(harness.resumeThreadCalls).toEqual(['thread-anonymous']);
        expect(harness.resumeConfigs[0]).toMatchObject({ model_provider: 'provider-a', model: 'profile-model' });
        expect(stub.getMetadata().agentModelCatalog).toEqual([{ id: 'profile-model', name: 'profile-model' }]);
        expect(session.sessionId).toBe('thread-anonymous');
        session.queue.push('next turn', createMode());
        await vi.waitFor(() => expect(harness.startTurnCalls).toBe(2));
        expect(harness.startThreadCalls).toBe(1);
        session.queue.close();
        await launch;
    });

    it('restores the previous process configuration when candidate startup fails', async () => {
        const stub = createSessionStub({ closeQueue: false });
        const session = stub.session as unknown as CodexSession;
        const launch = codexRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.startTurnCalls).toBe(1));
        harness.failHome = '/synthetic-failing-provider';
        session.codexEnvVars = { CODEX_HOME: harness.failHome };
        session.requireProviderResume = true;
        await expect(session.restartForProvider!()).rejects.toThrow('previous provider restored');
        await vi.waitFor(() => expect(harness.connectHomes).toEqual([undefined, '/synthetic-failing-provider', undefined]));
        expect(session.codexEnvVars).toBeUndefined();
        expect(session.sessionId).toBe('thread-anonymous');
        expect(harness.startThreadCalls).toBe(1);
        session.queue.close();
        await launch;
    });

    it('rolls back a failed thread resume instead of starting a new conversation', async () => {
        const stub = createSessionStub({ closeQueue: false });
        const session = stub.session as unknown as CodexSession;
        const launch = codexRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.startTurnCalls).toBe(1));
        harness.failResumeHome = '/synthetic-missing-thread';
        session.codexEnvVars = { CODEX_HOME: harness.failResumeHome };
        session.requireProviderResume = true;
        await expect(session.restartForProvider!()).rejects.toThrow('previous provider restored');
        await vi.waitFor(() => expect(harness.connectHomes).toHaveLength(3));
        expect(session.sessionId).toBe('thread-anonymous');
        expect(harness.startThreadCalls).toBe(1);
        session.queue.close();
        await launch;
    });

    it('rejects restarts while a turn is running', async () => {
        const stub = createSessionStub({ closeQueue: false });
        const session = stub.session as unknown as CodexSession;
        const launch = codexRemoteLauncher(session);
        await vi.waitFor(() => expect(harness.startTurnCalls).toBe(1));
        session.thinking = true;
        await expect(session.restartForProvider!()).rejects.toThrow('idle');
        expect(harness.connectHomes).toEqual([undefined]);
        session.thinking = false;
        session.queue.close();
        await launch;
    });

    it('publishes the live app-server model catalog to session metadata', async () => {
        const { session, getMetadata } = createSessionStub();
        await codexRemoteLauncher(session as never);
        expect(getMetadata().agentModelCatalog).toEqual([
            { id: 'test-codex-model', name: 'Test Codex Model', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra', isDefault: true }
        ]);
    });

    it('continues the session when model discovery is unavailable', async () => {
        harness.failModelDiscovery = true;
        const { session, getMetadata } = createSessionStub();
        expect(await codexRemoteLauncher(session as never)).toBe('exit');
        expect(getMetadata().agentModelCatalog).toBeUndefined();
        expect(harness.startThreadCalls).toBe(1);
    });

    it('finishes a turn and emits ready when task lifecycle events omit turn_id', async () => {
        delete process.env.CODEX_USE_MCP_SERVER;
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-anonymous');
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('keeps the running thread when appended system instructions change', async () => {
        const { session } = createSessionStub({ closeQueue: false });
        let injected = false;
        harness.onStartTurn = () => {
            if (injected) return;
            injected = true;
            session.queue.push('second message', {
                ...createMode(),
                appendSystemPrompt: 'updated instructions'
            });
            session.queue.close();
        };

        await codexRemoteLauncher(session as never);

        expect(harness.startThreadCalls).toBe(1);
        expect(harness.resumeThreadCalls).toEqual([]);
        expect(harness.startTurnCalls).toBe(2);
    });
});
