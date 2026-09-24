import type { Database } from 'bun:sqlite'
import { CredentialConfigSchema, isObject, type CredentialConfig, type ModelProtocol } from '@hapi/protocol'
import { safeJsonParse } from './json'

const DEFAULT_BASE_URLS: Record<ModelProtocol, string> = {
    'openai-responses': 'https://api.openai.com/v1',
    'openai-completions': 'https://api.openai.com/v1',
    'anthropic-messages': 'https://api.anthropic.com',
    'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta'
}

type FlatProvider = {
    provider: string
    model: string
    protocol: ModelProtocol
    apiKey: unknown
    baseUrl?: unknown
    headers?: unknown
    contextWindow?: unknown
    maxTokens?: unknown
}

function flatFromCodex(config: Record<string, unknown>): FlatProvider | null {
    if (typeof config.config !== 'string') return null
    try {
        const toml = Bun.TOML.parse(config.config) as Record<string, unknown>
        const provider = toml.model_provider
        const selected = typeof provider === 'string' && isObject(toml.model_providers) ? toml.model_providers[provider] : null
        if (typeof provider !== 'string' || typeof toml.model !== 'string' || !isObject(selected)) return null
        const auth = isObject(config.auth) ? config.auth : {}
        const envKey = typeof selected.env_key === 'string' ? selected.env_key : null
        return {
            provider,
            model: toml.model,
            protocol: selected.wire_api === 'chat' ? 'openai-completions' : 'openai-responses',
            apiKey: [auth.OPENAI_API_KEY, envKey ? auth[envKey] : undefined, selected.experimental_bearer_token]
                .find((value) => typeof value === 'string' && value.trim()),
            baseUrl: selected.base_url,
            headers: selected.http_headers
        }
    } catch {
        return null
    }
}

function flatFromLegacy(agentType: string, config: unknown): FlatProvider | null {
    if (!isObject(config)) return null
    if (agentType === 'codex') return flatFromCodex(config)
    if (agentType !== 'model-provider' && agentType !== 'pi') return null
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
    const protocol = [config.protocol, config.api].find((value): value is ModelProtocol =>
        typeof value === 'string' && value in DEFAULT_BASE_URLS) ?? 'openai-responses'
    return { ...config, provider: config.provider, model: config.model, protocol, apiKey: config.apiKey }
}

/** Convert a pre-v23 agent-specific credential; subscription logins have no agent-neutral form. */
export function credentialFromLegacy(agentType: string, config: unknown): CredentialConfig | null {
    const flat = flatFromLegacy(agentType, config)
    if (!flat) return null
    const parsed = CredentialConfigSchema.safeParse({
        provider: flat.provider.replace(/[^A-Za-z0-9_-]/g, '-'),
        apiKey: flat.apiKey,
        endpoints: { [flat.protocol]: typeof flat.baseUrl === 'string' ? flat.baseUrl : DEFAULT_BASE_URLS[flat.protocol] },
        ...(isObject(flat.headers) && Object.keys(flat.headers).length > 0 ? { headers: flat.headers } : {}),
        models: [{
            id: flat.model,
            ...(typeof flat.contextWindow === 'number' ? { contextWindow: flat.contextWindow } : {}),
            ...(typeof flat.maxTokens === 'number' ? { maxTokens: flat.maxTokens } : {})
        }],
        defaultModel: flat.model
    })
    return parsed.success ? parsed.data : null
}

/** Rows sharing an account (endpoints + key + headers) collapse into one credential with a model list. */
export function migrateCredentialsToV23(db: Database): void {
    const rows = db.prepare('SELECT id, namespace, agent_type, config FROM credentials ORDER BY updated_at DESC')
        .all() as Array<{ id: string; namespace: string; agent_type: string; config: string }>
    const accounts = new Map<string, { id: string; config: CredentialConfig }>()
    const remove = db.prepare('DELETE FROM credentials WHERE id = ?')
    for (const row of rows) {
        const config = credentialFromLegacy(row.agent_type, safeJsonParse(row.config))
        if (!config) {
            remove.run(row.id)
            continue
        }
        const key = JSON.stringify([row.namespace, config.apiKey, config.endpoints, config.headers ?? {}])
        const account = accounts.get(key)
        if (!account) {
            accounts.set(key, { id: row.id, config })
            continue
        }
        const known = new Set(account.config.models.map((model) => model.id))
        account.config.models.push(...config.models.filter((model) => !known.has(model.id)))
        remove.run(row.id)
    }
    const update = db.prepare('UPDATE credentials SET config = ? WHERE id = ?')
    for (const { id, config } of accounts.values()) update.run(JSON.stringify(config), id)
    db.exec(`
        DROP INDEX IF EXISTS idx_credentials_agent_type;
        ALTER TABLE credentials DROP COLUMN agent_type;
    `)
}
