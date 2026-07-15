import { AcpSdkBackend } from '@/agent/backends/acp';
import { buildGrokEnv, resolveGrokRuntimeConfig } from './config';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

export function createGrokBackend(opts: {
    model?: string;
    cwd?: string;
    permissionMode?: string;
    /** Optional process-level rules; session/new `_meta.rules` is preferred for per-session prompts. */
    rules?: string;
}): AcpSdkBackend {
    const { model } = resolveGrokRuntimeConfig({ model: opts.model });

    // `grok agent stdio` — ACP server over stdin/stdout.
    // Model / always-approve belong on `grok agent`, before the mode name.
    const args = ['agent'];
    if (model) {
        args.push('--model', model);
    }
    if (opts.permissionMode === 'bypassPermissions') {
        args.push('--always-approve');
    }
    if (opts.rules && opts.rules.trim().length > 0) {
        args.push('--rules', opts.rules.trim());
    }
    args.push('stdio');

    const env = buildGrokEnv({
        model,
        cwd: opts.cwd
    });

    return new AcpSdkBackend({
        command: 'grok',
        args,
        env: filterEnv(env),
        // Grok requires authenticate after initialize (cached OAuth / API key).
        authMethodId: 'auto'
    });
}
