import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, stringify, type TomlTable } from 'smol-toml'
import { isObject, type CredentialAgent, type CredentialConfig, type ModelProtocol } from '@hapi/protocol'
import { CLAUDE_CREDENTIAL_ENV_KEYS, claudeSettings, codexConfig, codexModelCatalog, piProvider } from './adapters'

const codexHome = () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
const claudeHome = () => join(homedir(), '.claude')
const piHome = () => join(homedir(), '.pi', 'agent')

async function readJson(path: string): Promise<Record<string, unknown>> {
    try {
        const value = JSON.parse(await readFile(path, 'utf-8'))
        return isObject(value) ? value : {}
    } catch {
        return {}
    }
}

async function readToml(path: string): Promise<TomlTable> {
    try {
        return parse(await readFile(path, 'utf-8'))
    } catch {
        return {}
    }
}

async function backupAndWrite(path: string, content: string): Promise<void> {
    await rename(path, `${path}.bak.${Date.now()}`).catch(() => {})
    await writeFile(path, content, { mode: 0o600 })
}

export async function applyCredential(agent: CredentialAgent, config: CredentialConfig): Promise<string[]> {
    if (agent === 'codex') {
        const home = codexHome()
        await mkdir(home, { recursive: true })
        const catalogPath = join(home, 'hapi-models.json')
        await writeFile(catalogPath, JSON.stringify(await codexModelCatalog(config), null, 2), { mode: 0o600 })
        const configPath = join(home, 'config.toml')
        const existing = await readToml(configPath)
        const next = codexConfig(config)
        const providers = isObject(existing.model_providers) ? existing.model_providers as TomlTable : {}
        delete existing.review_model
        await backupAndWrite(configPath, stringify({
            ...existing,
            ...next,
            model_catalog_json: catalogPath,
            model_providers: { ...providers, ...next.model_providers as TomlTable }
        }))
        return ['hapi-models.json', 'config.toml']
    }

    if (agent === 'claude') {
        const home = claudeHome()
        await mkdir(home, { recursive: true })
        const settingsPath = join(home, 'settings.json')
        const settings = await readJson(settingsPath)
        const env = isObject(settings.env) ? settings.env : {}
        for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) delete env[key]
        const next = claudeSettings(config)
        await backupAndWrite(settingsPath, JSON.stringify({ ...settings, env: { ...env, ...next.env }, modelPicker: next.modelPicker }, null, 2))
        return ['settings.json']
    }

    const home = piHome()
    await mkdir(home, { recursive: true, mode: 0o700 })
    const modelsPath = join(home, 'models.json')
    const models = await readJson(modelsPath)
    const providers = isObject(models.providers) ? models.providers : {}
    await backupAndWrite(modelsPath, JSON.stringify({ ...models, providers: { ...providers, [config.provider]: piProvider(config) } }, null, 2))
    const settingsPath = join(home, 'settings.json')
    const settings = await readJson(settingsPath)
    await backupAndWrite(settingsPath, JSON.stringify({ ...settings, defaultProvider: config.provider, defaultModel: config.defaultModel }, null, 2))
    return ['models.json', 'settings.json']
}

const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
const providerId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '-')

function modelsFrom(entries: unknown, fallback: string | undefined, pick: (entry: Record<string, unknown>) => unknown) {
    const models = (Array.isArray(entries) ? entries : []).filter(isObject).map(pick).filter(isObject)
    return models.length > 0 ? models : fallback ? [{ id: fallback }] : []
}

/** Best-effort conversion of the agent's current API-key configuration; the hub validates the result. */
export async function readCredential(agent: CredentialAgent): Promise<Record<string, unknown> | null> {
    if (agent === 'codex') {
        const home = codexHome()
        const config = await readToml(join(home, 'config.toml'))
        const provider = str(config.model_provider)
        const providers = isObject(config.model_providers) ? config.model_providers : {}
        const selected = provider && isObject(providers[provider]) ? providers[provider] : null
        if (!provider || !selected) return null
        const auth = await readJson(join(home, 'auth.json'))
        const envKey = str(selected.env_key)
        const catalog = str(config.model_catalog_json) ? await readJson(config.model_catalog_json as string) : {}
        const model = str(config.model)
        const models = modelsFrom(catalog.models, model, (entry) => str(entry.slug) && {
            id: entry.slug,
            ...(str(entry.display_name) && entry.display_name !== entry.slug ? { name: entry.display_name } : {}),
            ...(typeof entry.context_window === 'number' ? { contextWindow: entry.context_window } : {})
        })
        return {
            provider: providerId(provider),
            apiKey: str(selected.experimental_bearer_token) ?? str(auth.OPENAI_API_KEY)
                ?? (envKey ? str(auth[envKey]) ?? str(process.env[envKey]) : undefined),
            endpoints: { 'openai-responses': str(selected.base_url) ?? 'https://api.openai.com/v1' },
            ...(isObject(selected.http_headers) ? { headers: selected.http_headers } : {}),
            models,
            defaultModel: model ?? (models[0] as { id?: string } | undefined)?.id
        }
    }

    if (agent === 'claude') {
        const settings = await readJson(join(claudeHome(), 'settings.json'))
        const env = isObject(settings.env) ? settings.env : {}
        const apiKey = str(env.ANTHROPIC_AUTH_TOKEN) ?? str(env.ANTHROPIC_API_KEY)
        if (!apiKey) return null
        const baseUrl = str(env.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com'
        const model = str(env.ANTHROPIC_MODEL)
        const picker = isObject(settings.modelPicker) ? settings.modelPicker.options : undefined
        const models = modelsFrom(picker, model, (entry) => str(entry.model) && {
            id: entry.model,
            ...(str(entry.label) && entry.label !== entry.model ? { name: entry.label } : {})
        })
        const headers = str(env.ANTHROPIC_CUSTOM_HEADERS)?.split('\n').map((line) => line.split(/:\s*/, 2))
            .filter((pair): pair is [string, string] => pair.length === 2)
        return {
            provider: providerId(new URL(baseUrl).hostname.split('.').slice(-2, -1)[0] ?? 'anthropic'),
            apiKey,
            endpoints: { 'anthropic-messages': baseUrl },
            ...(headers?.length ? { headers: Object.fromEntries(headers) } : {}),
            models,
            defaultModel: model ?? (models[0] as { id?: string } | undefined)?.id
        }
    }

    const home = piHome()
    const models = await readJson(join(home, 'models.json'))
    const providers = isObject(models.providers) ? models.providers : {}
    const settings = await readJson(join(home, 'settings.json'))
    const provider = str(settings.defaultProvider) && isObject(providers[settings.defaultProvider as string])
        ? settings.defaultProvider as string : Object.keys(providers)[0]
    const selected = provider && isObject(providers[provider]) ? providers[provider] : null
    if (!provider || !selected) return null
    const list = modelsFrom(selected.models, undefined, (entry) => str(entry.id) && {
        id: entry.id,
        ...(str(entry.name) ? { name: entry.name } : {}),
        ...(typeof entry.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {}),
        ...(typeof entry.maxTokens === 'number' ? { maxTokens: entry.maxTokens } : {})
    })
    const defaultModel = str(settings.defaultModel)
    return {
        provider: providerId(provider),
        apiKey: selected.apiKey,
        endpoints: { [(str(selected.api) ?? 'openai-responses') as ModelProtocol]: selected.baseUrl },
        ...(isObject(selected.headers) ? { headers: selected.headers } : {}),
        models: list,
        defaultModel: defaultModel && list.some((model) => (model as { id: string }).id === defaultModel)
            ? defaultModel : (list[0] as { id?: string } | undefined)?.id
    }
}
