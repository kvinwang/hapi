import { describe, expect, it } from 'bun:test'
import { materializeProviderForAgent, normalizeModelProviderCredential, providerModelForAgent } from './modelProviderCredentials'

describe('model provider credentials', () => {
    const universal = {
        provider: 'gateway', model: 'model-a', protocol: 'openai-responses' as const,
        baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key', headers: { 'x-test': 'value' }
    }

    it('materializes one credential for Pi and Codex', () => {
        const pi = materializeProviderForAgent(universal, 'pi')
        expect(pi).toEqual(universal)
        expect(providerModelForAgent(universal, 'pi')).toBe('gateway/model-a')

        const codex = materializeProviderForAgent(universal, 'codex')
        expect(codex.auth).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'test-key' })
        expect(codex.config).toContain('model_provider = "gateway"')
        expect(codex.config).toContain('wire_api = "responses"')
    })

    it('normalizes compatible legacy Codex providers for Pi', () => {
        const normalized = normalizeModelProviderCredential('codex', {
            auth: { OPENAI_API_KEY: 'test-key' },
            config: 'model = "model-a"\nmodel_provider = "gateway"\n[model_providers.gateway]\nbase_url = "https://provider.invalid/v1"\nwire_api = "responses"\n'
        })
        expect(normalized).toMatchObject({
            provider: 'gateway', model: 'model-a', protocol: 'openai-responses',
            baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key'
        })
    })

    it('does not expose OAuth-only Codex credentials as universal providers', () => {
        expect(normalizeModelProviderCredential('codex', {
            auth: { auth_mode: 'chatgpt', tokens: {} }, config: 'model = "model-a"'
        })).toBeNull()
    })
})
