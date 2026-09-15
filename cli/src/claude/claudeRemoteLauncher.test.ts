import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

type NextMessage = () => Promise<{ message: string; mode: EnhancedMode } | null>;
type LaunchOpts = { initialMode: EnhancedMode; nextMessage: NextMessage; onMessage: (message: unknown) => void };
type LaunchHandler = (opts: LaunchOpts, call: number) => Promise<void>;

const harness = vi.hoisted(() => ({
    launches: [] as LaunchOpts[],
    handler: null as LaunchHandler | null
}));

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: LaunchOpts) => {
        harness.launches.push(opts);
        await harness.handler!(opts, harness.launches.length);
    }
}));

vi.mock('./claudeGoalAdapter', () => ({
    ClaudeGoalAdapter: class {
        isAvailable() { return false; }
    }
}));

import { claudeRemoteLauncher, launchRetryDelayMs } from './claudeRemoteLauncher';

function createSessionStub() {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify({
        permissionMode: mode.permissionMode,
        model: mode.model
    }));
    const events: string[] = [];
    const rpcHandlers = new Map<string, () => Promise<unknown>>();
    const session = {
        path: '/tmp/hapi-claude-remote-test',
        logPath: '/tmp/hapi-claude-remote-test/test.log',
        sessionId: null as string | null,
        mode: 'remote',
        thinking: false,
        queue,
        allowedTools: [],
        mcpServers: {},
        hookSettingsPath: '/tmp/hooks.json',
        claudeEnvVars: undefined,
        claudeArgs: undefined,
        client: {
            sessionId: 'hapi-session',
            rpcHandlerManager: {
                registerHandler(method: string, handler: () => Promise<unknown>) {
                    rpcHandlers.set(method, handler);
                }
            },
            sendSessionEvent(event: { type: string; message?: string }) {
                if (event.type === 'message' && event.message) events.push(event.message);
            },
            sendClaudeSessionMessage() {},
            updateMetadata() {},
            updateAgentState() {},
            getDebugState() { return {}; }
        },
        getPermissionMode: () => 'bypassPermissions',
        getModelMode: () => 'default',
        getEffortMode: () => 'default',
        onThinkingChange() {},
        setPermissionMode() {},
        onSessionFound() {},
        addSessionFoundCallback() {},
        removeSessionFoundCallback() {},
        clearSessionId() {},
        consumeOneTimeFlags() {}
    };
    const exit = async () => { await rpcHandlers.get('switch')!(); };
    return { session, queue, events, exit };
}

describe('launchRetryDelayMs', () => {
    it('doubles from one second up to a cap', () => {
        expect([1, 2, 3, 4, 6, 10].map(launchRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 30000, 30000]);
    });
});

describe('claudeRemoteLauncher launch failures', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        harness.launches = [];
    });

    afterEach(() => {
        vi.useRealTimers();
        harness.handler = null;
    });

    it('backs off between failed launches instead of respawning immediately', async () => {
        harness.handler = async () => { throw new Error('No conversation found with session ID: x'); };
        const { session, exit } = createSessionStub();
        const done = claudeRemoteLauncher(session as never);

        await vi.advanceTimersByTimeAsync(0);
        expect(harness.launches).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(harness.launches).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.launches).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(2000);
        expect(harness.launches).toHaveLength(3);

        await exit();
        await vi.advanceTimersByTimeAsync(0);
        await expect(done).resolves.toBe('switch');
    });

    it('stops retrying after repeated failures until the user sends a message', async () => {
        harness.handler = async () => { throw new Error('boom'); };
        const { session, queue, events, exit } = createSessionStub();
        const done = claudeRemoteLauncher(session as never);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.launches).toHaveLength(5);
        expect(events.at(-1)).toBe('Claude failed to start 5 times in a row. Send a message to try again.');

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(harness.launches).toHaveLength(5);

        queue.push('retry please', { permissionMode: 'bypassPermissions' });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.launches).toHaveLength(6);

        await exit();
        await vi.advanceTimersByTimeAsync(0);
        await expect(done).resolves.toBe('switch');
    });

    it('retries once more for a message queued while launches were failing', async () => {
        harness.handler = async () => { throw new Error('boom'); };
        const { session, queue, events, exit } = createSessionStub();
        const done = claudeRemoteLauncher(session as never);

        await vi.advanceTimersByTimeAsync(2_000);
        queue.push('are you there?', { permissionMode: 'bypassPermissions' });

        // The first streak ends without a notice because a message is waiting...
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.launches).toHaveLength(10);
        const notice = 'Claude failed to start 5 times in a row. Send a message to try again.';
        expect(events.filter((event) => event === notice)).toHaveLength(1);

        // ...but the still-queued message cannot keep the loop going.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(harness.launches).toHaveLength(10);

        await exit();
        await vi.advanceTimersByTimeAsync(0);
        await expect(done).resolves.toBe('switch');
    });

    it('keeps the queued message for the next successful launch', async () => {
        const delivered: string[] = [];
        harness.handler = async (opts, call) => {
            if (call === 1) throw new Error('boom');
            const next = await opts.nextMessage();
            if (next) delivered.push(next.message);
        };
        const { session, queue, exit } = createSessionStub();
        queue.push('hello', { permissionMode: 'bypassPermissions' });
        const done = claudeRemoteLauncher(session as never);

        await vi.advanceTimersByTimeAsync(1000);
        expect(delivered).toEqual(['hello']);

        await exit();
        await vi.advanceTimersByTimeAsync(0);
        await expect(done).resolves.toBe('switch');
    });
});

describe('claudeRemoteLauncher restarts', () => {
    beforeEach(() => {
        harness.launches = [];
    });

    it('remembers the prompt of a message delivered after a mode restart', async () => {
        const oldMode: EnhancedMode = { permissionMode: 'bypassPermissions', appendSystemPrompt: 'old prompt' };
        const newMode: EnhancedMode = { permissionMode: 'bypassPermissions', model: 'opus', appendSystemPrompt: 'new prompt' };
        let releaseLast: () => void = () => {};
        harness.handler = async (opts, call) => {
            if (call <= 2) {
                // Each of these queries ends when the next message needs a restart.
                while (await opts.nextMessage()) { /* keep reading */ }
                return;
            }
            if (call === 3) {
                // Receives the new-mode message as the pending one, then ends as /clear does.
                await opts.nextMessage();
                return;
            }
            await new Promise<void>((resolve) => { releaseLast = resolve; });
        };
        const { session, queue, exit } = createSessionStub();
        queue.push('first', oldMode);
        queue.push('second', newMode);
        const done = claudeRemoteLauncher(session as never);

        await vi.waitFor(() => expect(harness.launches).toHaveLength(4));
        expect(harness.launches[2].initialMode.appendSystemPrompt).toBe('new prompt');
        expect(harness.launches[3].initialMode.appendSystemPrompt).toBe('new prompt');
        expect(harness.launches[3].initialMode.model).toBeUndefined();

        const exiting = exit();
        releaseLast();
        await exiting;
        await expect(done).resolves.toBe('switch');
    });

    it('starts the query after a restart with the prompt of the last accepted message', async () => {
        const mode: EnhancedMode = { permissionMode: 'bypassPermissions', appendSystemPrompt: 'be helpful' };
        let releaseSecond: () => void = () => {};
        harness.handler = async (opts, call) => {
            if (call === 1) {
                // Accept one message, then end the query the way /clear does.
                await opts.nextMessage();
                return;
            }
            await new Promise<void>((resolve) => { releaseSecond = resolve; });
        };
        const { session, queue, exit } = createSessionStub();
        queue.push('/clear', mode);
        const done = claudeRemoteLauncher(session as never);

        await vi.waitFor(() => expect(harness.launches).toHaveLength(2));
        expect(harness.launches[1].initialMode.appendSystemPrompt).toBe('be helpful');
        expect(harness.launches[1].initialMode.permissionMode).toBe('bypassPermissions');

        const exiting = exit();
        releaseSecond();
        await exiting;
        await expect(done).resolves.toBe('switch');
    });
});
