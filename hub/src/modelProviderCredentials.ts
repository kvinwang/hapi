import { z } from 'zod'
import { isObject } from '@hapi/protocol'

export const ModelProviderConfigSchema = z.object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    protocol: z.enum(['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']).optional(),
    api: z.enum(['openai-responses', 'openai-completions', 'anthropic-messages', 'google-generative-ai']).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    apiKey: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    contextWindow: z.number().positive().optional(),
    maxTokens: z.number().positive().optional()
}).transform(({ api, protocol, ...value }) => ({ ...value, protocol: protocol ?? api ?? 'openai-responses' as const }))

export type ModelProviderConfig = z.output<typeof ModelProviderConfigSchema>

export function normalizeModelProviderCredential(agentType: string, config: unknown): ModelProviderConfig | null {
    const direct = ModelProviderConfigSchema.safeParse(config)
    if ((agentType === 'model-provider' || agentType === 'pi') && direct.success) return direct.data
    if (agentType !== 'codex' || !isObject(config) || !isObject(config.auth) || typeof config.config !== 'string') return null
    const apiKey = config.auth.OPENAI_API_KEY
    if (typeof apiKey !== 'string' || !apiKey) return null
    try {
        const toml = Bun.TOML.parse(config.config) as Record<string, unknown>
        const provider = typeof toml.model_provider === 'string' ? toml.model_provider : null
        const model = typeof toml.model === 'string' ? toml.model : null
        const providers = isObject(toml.model_providers) ? toml.model_providers : null
        const selected = provider && providers && isObject(providers[provider]) ? providers[provider] : null
        if (!provider || !model || !selected) return null
        const wireApi = selected.wire_api
        return ModelProviderConfigSchema.parse({
            provider,
            model,
            apiKey,
            ...(typeof selected.base_url === 'string' ? { baseUrl: selected.base_url } : {}),
            protocol: wireApi === 'chat' ? 'openai-completions' : 'openai-responses',
            ...(isObject(selected.http_headers) ? { headers: selected.http_headers } : {})
        })
    } catch {
        return null
    }
}

export function providerModelForAgent(config: ModelProviderConfig, agent: 'codex' | 'pi'): string {
    return agent === 'pi' ? `${config.provider}/${config.model}` : config.model
}

export function materializeProviderForAgent(config: ModelProviderConfig, agent: 'codex' | 'pi'): Record<string, unknown> {
    if (agent === 'pi') return config
    const key = JSON.stringify(config.provider)
    const lines = [
        `model = ${JSON.stringify(config.model)}`,
        `model_provider = ${key}`,
        '',
        `[model_providers.${key}]`,
        `name = ${key}`,
        `wire_api = ${JSON.stringify(config.protocol === 'openai-completions' ? 'chat' : 'responses')}`,
        'requires_openai_auth = false'
    ]
    if (config.baseUrl) lines.push(`base_url = ${JSON.stringify(config.baseUrl)}`)
    if (config.headers && Object.keys(config.headers).length > 0) {
        lines.push('', `[model_providers.${key}.http_headers]`)
        for (const [name, value] of Object.entries(config.headers)) lines.push(`${JSON.stringify(name)} = ${JSON.stringify(value)}`)
    }
    return { auth: { auth_mode: 'apikey', OPENAI_API_KEY: config.apiKey }, config: `${lines.join('\n')}\n` }
}
