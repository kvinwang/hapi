import { isObject, MODEL_PROTOCOLS, type CredentialConfig, type CredentialModel, type ModelProtocol } from '@hapi/protocol'

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
