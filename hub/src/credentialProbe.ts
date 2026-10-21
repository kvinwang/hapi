import { MODEL_PROTOCOLS, type CredentialModel, type ModelProtocol } from '@hapi/protocol'
import { modelsFromPayload } from './modelDiscovery'

export type CredentialProbeResult = {
    endpoints: Partial<Record<ModelProtocol, string>>
    models: CredentialModel[]
    notes: string[]
}

type ProbeResponse = {
    ok: boolean
    status: number
    body: string
    json: Record<string, unknown> | null
}

const TIMEOUT_MS = 10_000
const MAX_BODY = 2 * 1024 * 1024

function normalizeBase(raw: string): string {
    const trimmed = raw.trim()
    if (!trimmed) throw new Error('Base URL is required')
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    return url.replace(/\/+$/, '')
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))]
}

function basesFor(base: string) {
    const stem = base.replace(/\/(v1|v1beta|anthropic|openai)$/i, '')
    const openai = /\/v1$/i.test(base) ? base : `${stem}/v1`
    const anthropic = /\/anthropic$/i.test(base) ? [base] : [`${stem}/anthropic`, stem]
    return { stem, openai, anthropic: unique(anthropic) }
}

function isJson(response: Response): boolean {
    return (response.headers.get('content-type') ?? '').toLowerCase().includes('json')
}

async function read(response: Response): Promise<ProbeResponse> {
    const text = await response.text()
    const body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text
    let json: Record<string, unknown> | null = null
    if (isJson(response) || body.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(body)
            json = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
        } catch {
            json = null
        }
    }
    return { ok: response.ok, status: response.status, body, json }
}

async function fetchJson(url: string, init: RequestInit): Promise<ProbeResponse> {
    try {
        return await read(await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }))
    } catch (error) {
        return { ok: false, status: 0, body: error instanceof Error ? error.message : 'request failed', json: null }
    }
}

function modelFromList(body: unknown): CredentialModel[] {
    return modelsFromPayload(body)
}

async function probeModels(url: string, headers: Record<string, string>): Promise<CredentialModel[]> {
    const response = await fetchJson(url, { headers })
    return response.ok ? modelFromList(response.json ?? response.body) : []
}

async function probeOpenAi(base: string, apiKey: string, headers: Record<string, string>) {
    const auth = { ...headers, authorization: `Bearer ${apiKey}` }
    const models = await probeModels(`${base}/models`, auth)
    const model = models[0]?.id
    const protocols: ModelProtocol[] = []
    if (model) {
        const completions = await fetchJson(`${base}/chat/completions`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
        })
        if (supports(completions)) protocols.push('openai-completions')
        const responses = await fetchJson(`${base}/responses`, {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ model, max_output_tokens: 1, input: 'ping' })
        })
        if (supports(responses)) protocols.push('openai-responses')
    }
    return { models, protocols }
}

function supports(response: ProbeResponse): boolean {
    if (response.status === 0) return false
    if (response.status === 404 || response.status === 405) return false
    if (response.status === 401 || response.status === 403) return false
    return true
}

function anthropicShaped(response: ProbeResponse): boolean {
    const error = response.json?.error
    if (response.json?.type !== 'error' || !error || typeof error !== 'object') return false
    const type = (error as { type?: unknown }).type
    return type !== 'authentication_error' && type !== 'permission_error'
}

async function probeAnthropic(base: string, apiKey: string, headers: Record<string, string>, model: string | undefined) {
    const auth = {
        ...headers,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
    }
    const response = await fetchJson(`${base}/v1/messages`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
            model: model ?? 'claude-3-5-haiku-latest',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }]
        })
    })
    return response.ok || anthropicShaped(response) ? base : null
}

function googleBases(stem: string): string[] {
    return unique([`${stem}/v1beta`, stem])
}

async function probeGoogle(stem: string, apiKey: string, headers: Record<string, string>) {
    for (const base of googleBases(stem)) {
        const url = `${base}/models?key=${encodeURIComponent(apiKey)}`
        const response = await fetchJson(url, { headers: { ...headers, 'x-goog-api-key': apiKey } })
        const models = response.ok ? modelFromList(response.json ?? response.body) : []
        if (models.length > 0) return { base: base.replace(/\/v1beta$/i, ''), models }
    }
    return null
}

/**
 * Probe a gateway base URL and return the credential endpoints it actually speaks.
 * OpenAI routes are verified with the first listed model; Anthropic routes are
 * recognized by their JSON error envelope; Gemini routes by their model list.
 */
export async function probeCredential(input: {
    baseUrl: string
    apiKey: string
    headers?: Record<string, string>
}): Promise<CredentialProbeResult> {
    const base = normalizeBase(input.baseUrl)
    const headers = input.headers ?? {}
    const { stem, openai, anthropic } = basesFor(base)
    const endpoints: Partial<Record<ModelProtocol, string>> = {}
    const notes: string[] = []
    const models = new Map<string, CredentialModel>()

    const openaiResult = await probeOpenAi(openai, input.apiKey, headers)
    for (const model of openaiResult.models) models.set(model.id, model)
    for (const protocol of openaiResult.protocols) endpoints[protocol] = openai
    if (openaiResult.protocols.length > 0) notes.push(openaiResult.protocols.join(', '))

    for (const candidate of anthropic) {
        const found = await probeAnthropic(candidate, input.apiKey, headers, [...models.keys()][0])
        if (found) {
            endpoints['anthropic-messages'] = found
            notes.push('anthropic-messages')
            if (models.size === 0) {
                const listed = await probeModels(`${found}/v1/models?limit=1000`, {
                    ...headers,
                    authorization: `Bearer ${input.apiKey}`,
                    'x-api-key': input.apiKey,
                    'anthropic-version': '2023-06-01'
                })
                for (const model of listed) models.set(model.id, model)
            }
            break
        }
    }

    const google = await probeGoogle(stem, input.apiKey, headers)
    if (google) {
        endpoints['google-generative-ai'] = google.base
        for (const model of google.models) models.set(model.id, model)
        notes.push('google-generative-ai')
    }

    if (MODEL_PROTOCOLS.some((protocol) => endpoints[protocol])) {
        return { endpoints, models: [...models.values()], notes }
    }
    throw new Error(`No supported protocol detected (${notes.join('; ') || 'no endpoint answered'})`)
}
