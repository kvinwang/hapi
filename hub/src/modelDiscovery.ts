import { isObject, MODEL_PROTOCOLS, type CredentialConfig, type CredentialModel, type ModelProtocol } from '@hapi/protocol'
import type { Store } from './store'

const MODEL_SYNC_INTERVAL_MS = 60 * 60 * 1000

type DiscoveryTarget = Pick<CredentialConfig, 'apiKey' | 'endpoints' | 'headers'>

function listRequest(protocol: ModelProtocol, baseUrl: string, apiKey: string): { url: string; headers: Record<string, string> } {
    const base = baseUrl.replace(/\/+$/, '')
    if (protocol === 'anthropic-messages') {
        return {
            url: `${base}/v1/models?limit=1000`,
            headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' }
        }
    }
    if (protocol === 'google-generative-ai') {
        return { url: `${base}/models?pageSize=1000`, headers: { 'x-goog-api-key': apiKey } }
    }
    return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } }
}

const firstString = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
const firstPositiveInt = (...values: unknown[]) => values.find((value): value is number => Number.isInteger(value) && (value as number) > 0)

function toModel(entry: unknown): CredentialModel | null {
    if (!isObject(entry)) return null
    const id = firstString(entry.id, typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : undefined)
    if (!id) return null
    const name = firstString(entry.display_name, entry.displayName, entry.name !== id ? entry.name : undefined)
    const contextWindow = firstPositiveInt(entry.context_length, entry.context_window, entry.max_input_tokens, entry.inputTokenLimit)
    const maxTokens = firstPositiveInt(entry.max_output_tokens, entry.outputTokenLimit,
        isObject(entry.top_provider) ? entry.top_provider.max_completion_tokens : undefined)
    return {
        id,
        ...(name && name !== id && !name.startsWith('models/') ? { name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {})
    }
}

/** List models from the first endpoint that answers; OpenAI, Anthropic and Gemini list formats are accepted. */
export async function discoverModels(target: DiscoveryTarget): Promise<CredentialModel[]> {
    const errors: string[] = []
    for (const protocol of MODEL_PROTOCOLS) {
        const baseUrl = target.endpoints[protocol]
        if (!baseUrl) continue
        const request = listRequest(protocol, baseUrl, target.apiKey)
        try {
            const response = await fetch(request.url, {
                headers: { ...target.headers, ...request.headers },
                signal: AbortSignal.timeout(15_000)
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json() as Record<string, unknown>
            const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
            const models = new Map<string, CredentialModel>()
            for (const model of entries.map(toModel)) if (model) models.set(model.id, model)
            if (models.size === 0) throw new Error('empty model list')
            return [...models.values()]
        } catch (error) {
            errors.push(`${protocol}: ${error instanceof Error ? error.message : 'request failed'}`)
        }
    }
    throw new Error(`Unable to list models (${errors.join('; ')})`)
}

/** Mirror the fetched list, keeping local edits to models that are still offered. */
export function syncModels(config: CredentialConfig, fetched: CredentialModel[]): CredentialConfig {
    const current = new Map(config.models.map((model) => [model.id, model]))
    const models = fetched.map((model) => ({ ...model, ...current.get(model.id) }))
    const defaultModel = models.some((model) => model.id === config.defaultModel) ? config.defaultModel : models[0].id
    return { ...config, models, defaultModel }
}

async function syncAll(store: Store): Promise<void> {
    for (const credential of store.credentials.getAllCredentials()) {
        if (!credential.config.autoSyncModels) continue
        try {
            const fetched = await discoverModels(credential.config)
            const latest = store.credentials.getCredentialByNamespace(credential.id, credential.namespace)
            // Skip if edited while fetching; the next run picks up the new config.
            if (latest?.updatedAt !== credential.updatedAt) continue
            const config = syncModels(latest.config, fetched)
            if (JSON.stringify(config) === JSON.stringify(latest.config)) continue
            store.credentials.updateCredential(latest.id, latest.namespace, { config })
        } catch (error) {
            console.warn(`[Hub] Model sync failed for credential "${credential.name}": ${error instanceof Error ? error.message : error}`)
        }
    }
}

/** Refresh auto-synced credentials now and hourly; returns a stop function. */
export function startModelSync(store: Store): () => void {
    void syncAll(store)
    const timer = setInterval(() => void syncAll(store), MODEL_SYNC_INTERVAL_MS)
    return () => clearInterval(timer)
}
