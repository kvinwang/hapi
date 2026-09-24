import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import type { CredentialConfig } from '@hapi/protocol'
import { applyCredential, readCredential } from './machine'

vi.mock('./adapters', async (importOriginal) => ({
    ...await importOriginal<typeof import('./adapters')>(),
    codexModelCatalog: async (config: CredentialConfig) => ({
        models: config.models.map((model) => ({ slug: model.id, display_name: model.name ?? model.id, context_window: model.contextWindow }))
    })
}))

const credential: CredentialConfig = {
    provider: 'gateway',
    apiKey: 'synthetic-key',
    endpoints: {
        'openai-responses': 'https://gateway.invalid/v1',
        'anthropic-messages': 'https://gateway.invalid/anthropic'
    },
    headers: { 'x-team': 'hapi' },
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 200000 }, { id: 'model-b' }],
    defaultModel: 'model-b'
}

let home: string
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hapi-credential-test-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('CODEX_HOME', join(home, '.codex'))
})
afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
})

describe('machine credentials', () => {
    it('merges into Codex config without dropping unrelated settings and reads it back', async () => {
        await mkdir(join(home, '.codex'))
        await writeFile(join(home, '.codex', 'config.toml'), 'review_model = "gpt"\n[features]\nx = true\n[model_providers.other]\nname = "other"\n')
        await applyCredential('codex', credential)
        const config = parse(await readFile(join(home, '.codex', 'config.toml'), 'utf8'))
        expect(config).toMatchObject({
            model: 'model-b',
            model_provider: 'gateway',
            model_catalog_json: join(home, '.codex', 'hapi-models.json'),
            features: { x: true },
            model_providers: { other: { name: 'other' }, gateway: { experimental_bearer_token: 'synthetic-key' } }
        })
        expect(config.review_model).toBeUndefined()
        expect(await readCredential('codex')).toEqual({ ...credential, endpoints: { 'openai-responses': credential.endpoints['openai-responses'] } })
    })

    it('writes Claude env and model picker, replacing previous provider variables', async () => {
        await mkdir(join(home, '.claude'))
        await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', env: { ANTHROPIC_API_KEY: 'old', KEEP: '1' } }))
        await applyCredential('claude', credential)
        const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'))
        expect(settings.theme).toBe('dark')
        expect(settings.env).toEqual({
            KEEP: '1',
            ANTHROPIC_BASE_URL: 'https://gateway.invalid/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'synthetic-key',
            ANTHROPIC_MODEL: 'model-b',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-b',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-b',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-b',
            ANTHROPIC_CUSTOM_HEADERS: 'x-team: hapi'
        })
        expect(settings.modelPicker.options).toEqual([{ model: 'model-a', label: 'Model A' }, { model: 'model-b', label: 'model-b' }])
        const imported = await readCredential('claude')
        expect(imported).toMatchObject({ endpoints: { 'anthropic-messages': 'https://gateway.invalid/anthropic' }, defaultModel: 'model-b' })
    })

    it('writes the full Pi model list and reads it back', async () => {
        await applyCredential('pi', credential)
        const models = JSON.parse(await readFile(join(home, '.pi', 'agent', 'models.json'), 'utf8'))
        expect(models.providers.gateway).toMatchObject({ api: 'openai-responses', models: credential.models })
        expect(await readCredential('pi')).toEqual({ ...credential, endpoints: { 'openai-responses': credential.endpoints['openai-responses'] } })
    })

    it('rejects agents without a compatible endpoint', async () => {
        await expect(applyCredential('claude', { ...credential, endpoints: { 'openai-completions': 'https://x.invalid' } }))
            .rejects.toThrow('no endpoint compatible with claude')
    })
})
