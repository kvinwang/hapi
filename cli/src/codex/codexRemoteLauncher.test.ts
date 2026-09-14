import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    startThreadCalls: 0,
    failModelDiscovery: false,
    resumeThreadCalls: [] as string[],
    startTurnCalls: 0,
    onStartTurn: null as null | (() => void)
}));

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        async connect(): Promise<void> {}

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

        async resumeThread(params: { threadId: string }): Promise<{ thread: { id: string } }> {
            harness.resumeThreadCalls.push(params.threadId);
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

        async disconnect(): Promise<void> {}
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
        harness.failModelDiscovery = false;
        harness.resumeThreadCalls = [];
        harness.startTurnCalls = 0;
        harness.onStartTurn = null;
        delete process.env.CODEX_USE_MCP_SERVER;
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
