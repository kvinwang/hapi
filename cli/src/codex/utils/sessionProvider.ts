import { CodexProfileNameSchema, CodexProviderSelectionSchema, type CodexProviderOption } from '@hapi/protocol/schemas';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { z } from 'zod';

export const CodexProviderRequestSchema = CodexProviderSelectionSchema.extend({
    name: z.string().min(1),
    config: z.object({
        auth: z.record(z.string(), z.unknown()).optional(),
        config: z.string().default('')
    }).optional()
}).refine((value) => value.provider.source !== 'credential' || value.config !== undefined);

export type CodexProviderRequest = z.infer<typeof CodexProviderRequestSchema>;
export type PreparedSessionProvider = {
    config: Record<string, unknown>;
    profile?: string;
    home?: string;
    dispose?: () => Promise<void>;
};
const defaultHome = () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));

function parseProfile(source: string): TomlTable {
    try {
        return parse(source);
    } catch {
        // Parser errors may contain credential-bearing source lines.
        throw new Error('Invalid Codex provider configuration');
    }
}

async function readProfile(name: string, home: string): Promise<TomlTable> {
    if (!CodexProfileNameSchema.safeParse(name).success) throw new Error('Invalid Codex profile name');
    try {
        return parseProfile(await readFile(join(home, `${name}.config.toml`), 'utf8'));
    } catch {
        throw new Error('Unable to load Codex profile');
    }
}

export async function listSessionProfiles(home = defaultHome()): Promise<CodexProviderOption[]> {
    const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
    const profiles: CodexProviderOption[] = [];
    for (const entry of entries) {
        if (!entry.name.endsWith('.config.toml') || entry.name.startsWith('hapi-provider-')) continue;
        const name = entry.name.slice(0, -'.config.toml'.length);
        if (!CodexProfileNameSchema.safeParse(name).success) continue;
        try {
            const config = await readProfile(name, home);
            profiles.push({ provider: { source: 'profile', profile: name }, name,
                model: typeof config.model === 'string' ? config.model : 'auto' });
        } catch {
            // An unreadable profile must not hide the remaining choices.
        }
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/** Mirror native --profile for local mode; app-server receives the same TOML as an RPC overlay. */
export async function prepareSessionProvider(request: CodexProviderRequest, home = defaultHome()): Promise<PreparedSessionProvider | null> {
    if (request.provider.source === 'default') return null;
    if (request.provider.source === 'profile') {
        const config = await readProfile(request.provider.profile, home);
        const providers = config.model_providers;
        const hasIndependentAuth = providers && typeof providers === 'object'
            && Object.values(providers).some((provider) => provider && typeof provider === 'object'
                && ('auth' in provider || 'experimental_bearer_token' in provider || 'env_key' in provider));
        // RPC overlays merge provider tables with the global configuration. A command
        // auth profile must not inherit conflicting global authentication fields.
        if (hasIndependentAuth) return prepareIsolatedCredential(config, home);
        return { profile: request.provider.profile, config };
    }
    const config = parseProfile(request.config!.config);
    const key = request.config?.auth?.OPENAI_API_KEY;
    if (typeof key !== 'string' || !key.trim()) {
        throw new Error('Temporary provider switching requires an API key');
    }
    const providers = config.model_providers;
    const provider = typeof config.model_provider === 'string'
        && providers && typeof providers === 'object' && !Array.isArray(providers)
        ? (providers as TomlTable)[config.model_provider] : undefined;
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        throw new Error('Temporary provider switching requires an explicit provider configuration');
    }
    const selectedProvider = provider as TomlTable;
    delete selectedProvider.auth;
    delete selectedProvider.env_key;
    selectedProvider.requires_openai_auth = false;
    selectedProvider.experimental_bearer_token = key;
    return prepareIsolatedCredential(config, home);
}

/** Extract the native profile flag without forwarding it to app-server. */
export function parseCodexProfileArgs(args: string[] = []): { profile?: string; args: string[] } {
    let profile: string | undefined;
    const remaining: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') { remaining.push(...args.slice(i)); break; }
        if (arg === '--profile' || arg === '-p') profile = args[++i];
        else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length);
        else { remaining.push(arg); continue; }
        if (!CodexProfileNameSchema.safeParse(profile).success) throw new Error('Invalid Codex profile name');
    }
    return { profile, args: remaining };
}

/** Only configuration/auth are private; transcripts remain in the original home for resume. */
async function prepareIsolatedCredential(
    config: TomlTable,
    baseHome: string
): Promise<PreparedSessionProvider> {
    // Never consult the global keyring or let the selected config move runtime state.
    config.cli_auth_credentials_store = 'file';
    config.sqlite_home = baseHome;
    await mkdir(baseHome, { recursive: true });
    const home = await mkdtemp(join(baseHome, '.hapi-provider-'));
    const dispose = () => rm(home, { recursive: true, force: true });
    try {
        for (const name of ['sessions', 'archived_sessions']) {
            await mkdir(join(baseHome, name), { recursive: true });
            await symlink(join(baseHome, name), join(home, name), 'junction');
        }
        // Keep user instructions and skills available without copying global credentials/config.
        for (const name of ['AGENTS.md', 'skills', 'prompts']) {
            await symlink(join(baseHome, name), join(home, name), name === 'AGENTS.md' ? 'file' : 'junction');
        }
        await writeFile(join(home, 'config.toml'), stringify(config), { mode: 0o600, flag: 'wx' });
        return { home, config, dispose };
    } catch {
        await dispose();
        throw new Error('Unable to prepare isolated Codex provider');
    }
}

/** Remove ambient routing/auth overrides only when a database provider was selected. */
export function codexProcessEnv(overrides?: Record<string, string>): NodeJS.ProcessEnv {
    const env = { ...process.env, ...overrides };
    if (env.HAPI_CODEX_ISOLATED_PROVIDER === '1') {
        for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID']) {
            delete env[key];
        }
    }
    delete env.HAPI_CODEX_ISOLATED_PROVIDER;
    return env;
}
