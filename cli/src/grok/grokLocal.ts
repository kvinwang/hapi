import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import type { PermissionMode } from './types';

export async function grokLocal(opts: {
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
    permissionMode?: PermissionMode;
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.permissionMode && opts.permissionMode !== 'default') {
        args.push('--permission-mode', opts.permissionMode);
    }

    logger.debug(`[GrokLocal] Spawning grok with args: ${JSON.stringify(args)}`);

    process.stdin.pause();
    try {
        await spawnWithAbort({
            command: 'grok',
            args,
            cwd: opts.path,
            env: process.env,
            signal: opts.abort,
            shell: process.platform === 'win32',
            logLabel: 'GrokLocal',
            spawnName: 'grok',
            installHint: 'Grok Build CLI (https://grok.com or xAI docs)',
            includeCause: true,
            logExit: true
        });
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }
}
