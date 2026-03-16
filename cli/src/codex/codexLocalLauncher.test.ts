import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>
}));

vi.mock('./codexLocal', () => ({
    codexLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts);
    }
}));

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            url: 'http://localhost:0',
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('./utils/codexSessionScanner', () => ({
    createCodexSessionScanner: async () => ({
        cleanup: async () => {},
        onNewSession: () => {}
    })
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        readonly control = {
            requestExit: () => {}
        };

        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {}

        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal);
            return 'exit';
        }
    }
}));

import { codexLocalLauncher } from './codexLocalLauncher';

function createSessionStub(permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo', codexArgs?: string[]) {
    return {
        sessionId: null,
        path: '/tmp/worktree',
        startedBy: 'terminal' as const,
        startingMode: 'local' as const,
        codexArgs,
        client: {
            rpcHandlerManager: {}
        },
        getPermissionMode: () => permissionMode,
        onSessionFound: () => {},
        sendSessionEvent: () => {},
        recordLocalLaunchFailure: () => {},
        sendUserMessage: () => {},
        sendCodexMessage: () => {},
        queue: {}
    };
}

describe('codexLocalLauncher', () => {
    afterEach(() => {
        harness.launches = [];
    });

    it('rebuilds approval and sandbox args from yolo mode', async () => {
        const session = createSessionStub('yolo', [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'untrusted',
            '--model',
            'o3',
            '--full-auto'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);
    });

    it('preserves raw Codex approval flags in default mode', async () => {
        const session = createSessionStub('default', [
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('keeps sandbox escalation available in safe-yolo mode', async () => {
        const session = createSessionStub('safe-yolo', [
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-failure',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });
});
