import { request } from 'node:http';

function logError(message: string, error?: unknown): void {
    const detail = error instanceof Error ? error.message : (error ? String(error) : '');
    const suffix = detail ? `: ${detail}` : '';
    process.stderr.write(`[hook-forwarder] ${message}${suffix}\n`);
}

function parsePort(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }

    return port;
}

function parseArgs(args: string[]): { port: number | null; token: string | null } {
    let port: number | null = null;
    let token: string | null = null;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (!arg) {
            continue;
        }

        if (arg === '--port' || arg === '-p') {
            port = parsePort(args[i + 1]);
            i += 1;
            continue;
        }

        if (arg.startsWith('--port=')) {
            port = parsePort(arg.slice('--port='.length));
            continue;
        }

        if (arg === '--token' || arg === '-t') {
            token = args[i + 1] ?? null;
            i += 1;
            continue;
        }

        if (arg.startsWith('--token=')) {
            token = arg.slice('--token='.length);
            continue;
        }

        if (!port) {
            port = parsePort(arg);
            continue;
        }

        if (!token) {
            token = arg;
        }
    }

    return { port, token };
}

export async function runSessionHookForwarder(args: string[]): Promise<void> {
    const { port, token } = parseArgs(args);
    if (!port) {
        logError('Invalid or missing port argument');
        process.exitCode = 1;
        return;
    }

    if (!token) {
        logError('Missing hook token');
        process.exitCode = 1;
        return;
    }

    try {
        const chunks: Buffer[] = [];
        process.stdin.resume();
        for await (const chunk of process.stdin) {
            if (typeof chunk === 'string') {
                chunks.push(Buffer.from(chunk));
            } else {
                chunks.push(chunk as Buffer);
            }
        }

        let body = Buffer.concat(chunks);
        try {
            const hook: unknown = JSON.parse(body.toString('utf8'));
            if (hook && typeof hook === 'object' && 'hook_event_name' in hook
                && (hook.hook_event_name === 'PostToolUse' || hook.hook_event_name === 'UserPromptSubmit')) {
                const sessionId = 'session_id' in hook ? hook.session_id : undefined;
                body = Buffer.from(JSON.stringify({ session_id: sessionId, hook_event_name: hook.hook_event_name }));
            }
        } catch { /* Invalid input is rejected by the hook server. */ }

        let hadError = false;
        await new Promise<void>((resolve) => {
            const req = request({
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: '/hook/session-start',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    'x-hapi-hook-token': token
                }
            }, (res) => {
                if (res.statusCode && res.statusCode >= 400) {
                    hadError = true;
                    logError(`Hook server responded with status ${res.statusCode}`);
                }
                res.on('error', (error) => {
                    hadError = true;
                    logError('Error reading hook server response', error);
                    resolve();
                });
                const responseChunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => responseChunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode === 200 && res.headers['content-type']?.startsWith('application/json')) {
                        process.stdout.write(Buffer.concat(responseChunks).toString('utf8') + '\n');
                    }
                    resolve();
                });
            });

            req.setTimeout(5_000, () => req.destroy(new Error('Hook request timed out')));
            req.on('error', (error) => {
                hadError = true;
                logError('Failed to send hook request', error);
                resolve();
            });
            req.end(body);
        });
        if (hadError) {
            process.exitCode = 1;
        }
    } catch (error) {
        logError('Failed to forward session hook', error);
        process.exitCode = 1;
    }
}
