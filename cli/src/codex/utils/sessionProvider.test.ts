import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { CodexProviderRequestSchema, codexProcessEnv, prepareSessionProvider, listSessionProfiles, parseCodexProfileArgs } from './sessionProvider';

const homes: string[] = [];
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'hapi-provider-test-'));
    homes.push(home);
    await mkdir(join(home, 'sessions'));
    await writeFile(join(home, 'sessions', 'thread.jsonl'), 'synthetic transcript');
    await writeFile(join(home, 'config.toml'), 'model = "original"');
    return home;
}
const request = {
    provider: { source: 'credential' as const, credentialId: 'provider-a' }, name: 'Provider A', model: 'model-a',
    config: { auth: { OPENAI_API_KEY: 'synthetic-test-key' }, config: 'model = "model-a"\nmodel_provider = "custom"\n[features]\nexample = true\n[model_providers.custom]\nname = "Custom"\nbase_url = "https://provider.invalid/v1"' }
};
afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('session provider isolation', () => {
    it('loads a native profile without creating homes, touching auth, or modifying configuration', async () => {
        const home = await fixture();
        await writeFile(join(home, 'redpill.config.toml'), request.config.config);
        const before = await readdir(home);
        const selected = await prepareSessionProvider({ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'auto' }, home);
        expect(selected?.profile).toBe('redpill');
        expect(selected?.home).toBeUndefined();
        expect(selected?.dispose).toBeUndefined();
        expect(selected?.config.model_provider).toBe('custom');
        expect(await readdir(home)).toEqual(before);
        expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('model = "original"');
    });

    it('isolates command-auth profiles from conflicting global provider tables', async () => {
        const home = await fixture();
        await writeFile(join(home, 'config.toml'), request.config.config + '\nrequires_openai_auth = true');
        const source = request.config.config + '\n[model_providers.custom.auth]\ncommand = "printf"\nargs = ["synthetic-token"]';
        await writeFile(join(home, 'redpill.config.toml'), source);
        const selected = (await prepareSessionProvider({
            provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'model-a'
        }, home))!;
        expect(selected.home).not.toBe(home);
        expect(selected.profile).toBeUndefined();
        const config = parse(await readFile(join(selected.home!, 'config.toml'), 'utf8'));
        expect(config.model_providers).toEqual({ custom: {
            name: 'Custom', base_url: 'https://provider.invalid/v1',
            auth: { command: 'printf', args: ['synthetic-token'] }
        } });
        expect(await readFile(join(home, 'redpill.config.toml'), 'utf8')).toBe(source);
        expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('requires_openai_auth = true');
        await selected.dispose!();
    });

    it('requires independent API authentication for database selections', async () => {
        const home = await fixture();
        await expect(prepareSessionProvider({ ...request, config: { config: request.config.config } }, home))
            .rejects.toThrow('requires an API key');
        expect(await readdir(home)).toEqual(['config.toml', 'sessions']);
    });

    it('inlines the API key and removes conflicting authentication only in the snapshot', async () => {
        const home = await fixture();
        const source = request.config.config + '\nrequires_openai_auth = true\nenv_key = "UNUSED"\n[model_providers.custom.auth]\ncommand = "unused"';
        const selected = (await prepareSessionProvider({ ...request, config: { ...request.config, config: source } }, home))!;
        const config = parse(await readFile(join(selected.home!, 'config.toml'), 'utf8'));
        expect(config.model_providers).toEqual({ custom: {
            name: 'Custom', base_url: 'https://provider.invalid/v1',
            requires_openai_auth: false, experimental_bearer_token: 'synthetic-test-key'
        } });
        expect(await readdir(selected.home!)).not.toContain('auth.json');
        expect(source).toContain('command = "unused"');
        expect(request.config.auth).toEqual({ OPENAI_API_KEY: 'synthetic-test-key' });
        await selected.dispose!();
        await expect(stat(selected.home!)).rejects.toThrow();
    });

    it('lists sanitized profiles, skipping invalid and generated files', async () => {
        const home = await fixture();
        await writeFile(join(home, 'redpill.config.toml'), request.config.config);
        await writeFile(join(home, 'bad.config.toml'), '[');
        await writeFile(join(home, 'hapi-provider-generated.config.toml'), 'model = "hidden"');
        expect(await listSessionProfiles(home)).toEqual([{ provider: { source: 'profile', profile: 'redpill' }, name: 'redpill', model: 'model-a' }]);
    });

    it('rejects profile path traversal and missing profiles', async () => {
        const home = await fixture();
        for (const profile of ['../outside', '/absolute', 'missing']) {
            await expect(prepareSessionProvider({ provider: { source: 'profile', profile }, name: profile, model: 'auto' }, home)).rejects.toThrow();
        }
    });

    it('extracts native profile flags while preserving other arguments and the -- delimiter', () => {
        expect(parseCodexProfileArgs(['--profile', 'redpill', '--model', 'm'])).toEqual({ profile: 'redpill', args: ['--model', 'm'] });
        expect(parseCodexProfileArgs(['-p', 'one', '--profile=two'])).toEqual({ profile: 'two', args: [] });
        expect(parseCodexProfileArgs(['--', '--profile', 'redpill'])).toEqual({ args: ['--', '--profile', 'redpill'] });
        expect(() => parseCodexProfileArgs(['--profile'])).toThrow();
        expect(() => parseCodexProfileArgs(['--profile=../bad'])).toThrow();
    });

    it('retains complete config, isolates files, and preserves resume transcripts after cleanup', async () => {
        const base = await fixture();
        const selected = (await prepareSessionProvider(request, base))!;
        const config = parse(await readFile(join(selected.home!, 'config.toml'), 'utf8'));
        expect(config.features).toEqual({ example: true });
        expect(config.cli_auth_credentials_store).toBe('file');
        expect(config.sqlite_home).toBe(base);
        expect(selected.config.model_provider).toBe('custom');
        expect(await readFile(join(selected.home!, 'sessions', 'thread.jsonl'), 'utf8')).toBe('synthetic transcript');
        expect(await readFile(join(base, 'config.toml'), 'utf8')).toBe('model = "original"');
        if (process.platform !== 'win32') {
            expect((await stat(selected.home!)).mode & 0o777).toBe(0o700);
            expect((await stat(join(selected.home!, 'config.toml'))).mode & 0o777).toBe(0o600);
        }
        await selected.dispose!();
        expect(await readFile(join(base, 'sessions', 'thread.jsonl'), 'utf8')).toBe('synthetic transcript');
    });

    it('uses separate homes for simultaneous sessions', async () => {
        const base = await fixture();
        const [a, b] = await Promise.all([prepareSessionProvider(request, base), prepareSessionProvider(request, base)]);
        expect(a!.home).not.toBe(b!.home);
        await a!.dispose!();
        expect(await stat(join(b!.home!, 'config.toml'))).toBeDefined();
    });

    it('does not expose malformed TOML in errors', async () => {
        const base = await fixture();
        await expect(prepareSessionProvider({ ...request, config: { config: 'invalid = [fixture-content' } }, base))
            .rejects.toThrow('Invalid Codex provider configuration');
    });

    it('does not create an isolated home for machine defaults', async () => {
        expect(await prepareSessionProvider({ provider: { source: 'default' }, name: 'Default', model: 'auto' })).toBeNull();
    });

    it('rejects OAuth-only, blank keys, and missing provider definitions', async () => {
        const base = await fixture();
        for (const auth of [{ tokens: { synthetic: true } }, { OPENAI_API_KEY: ' ' }]) {
            await expect(prepareSessionProvider({ ...request, config: { ...request.config, auth } }, base))
                .rejects.toThrow('requires an API key');
        }
        await expect(prepareSessionProvider({ ...request, config: { auth: request.config.auth, config: '' } }, base))
            .rejects.toThrow('explicit provider configuration');
        expect(await readdir(base)).toEqual(['config.toml', 'sessions']);
    });

    it('rejects selections without a complete configuration envelope', () => {
        expect(CodexProviderRequestSchema.safeParse({ provider: { source: 'credential', credentialId: 'x' }, model: 'a', name: 'X' }).success).toBe(false);
    });

    it('removes ambient routing only for isolated providers and leaves the parent unchanged', () => {
        vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.invalid');
        const isolated = codexProcessEnv({ HAPI_CODEX_ISOLATED_PROVIDER: '1', CODEX_HOME: '/synthetic' });
        expect(isolated.OPENAI_BASE_URL).toBeUndefined();
        expect(isolated.HAPI_CODEX_ISOLATED_PROVIDER).toBeUndefined();
        expect(codexProcessEnv().OPENAI_BASE_URL).toBe('https://ambient.invalid');
        expect(process.env.OPENAI_BASE_URL).toBe('https://ambient.invalid');
    });
});
