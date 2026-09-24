import { useMemo, useState } from 'react'
import {
    CREDENTIAL_AGENTS,
    CredentialConfigSchema,
    MODEL_PROTOCOLS,
    compatibleCredentialAgents,
    type CredentialAgent,
    type CredentialConfig,
    type CredentialModel,
    type ModelProtocol
} from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import {
    useDiscoverCredentialModels,
    useReadMachineCredentials,
    useSaveCredential
} from '@/hooks/mutations/useCredentialActions'

export const inputClass = 'rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]'
export const secondaryButtonClass = 'shrink-0 rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50'
export const primaryButtonClass = 'shrink-0 rounded-lg bg-[var(--app-link)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'

export const AGENT_LABELS: Record<CredentialAgent, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' }
const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
    'openai-responses': 'OpenAI Responses',
    'openai-completions': 'OpenAI Chat Completions',
    'anthropic-messages': 'Anthropic Messages',
    'google-generative-ai': 'Google Gemini'
}

type Draft = {
    name: string
    provider: string
    apiKey: string
    endpoints: Array<{ protocol: ModelProtocol; url: string }>
    headers: string
    models: CredentialModel[]
    defaultModel: string
}

export type CredentialFormSeed = { id?: string; name: string; config?: CredentialConfig }

function toDraft(name: string, config?: CredentialConfig): Draft {
    return {
        name,
        provider: config?.provider ?? '',
        apiKey: config?.apiKey ?? '',
        endpoints: config
            ? Object.entries(config.endpoints).map(([protocol, url]) => ({ protocol: protocol as ModelProtocol, url: url ?? '' }))
            : [{ protocol: 'openai-responses', url: '' }],
        headers: Object.entries(config?.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n'),
        models: config?.models ?? [],
        defaultModel: config?.defaultModel ?? ''
    }
}

function parseHeaders(text: string): Record<string, string> | undefined {
    const entries = text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const index = line.indexOf(':')
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const
    }).filter(([key]) => key)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function draftEndpoints(draft: Draft): CredentialConfig['endpoints'] {
    return Object.fromEntries(draft.endpoints.filter((endpoint) => endpoint.url.trim())
        .map((endpoint) => [endpoint.protocol, endpoint.url.trim()]))
}

export function CredentialForm(props: {
    api: ApiClient | null
    seed: CredentialFormSeed
    machines: Machine[]
    onClose: () => void
}) {
    const [draft, setDraft] = useState(() => toDraft(props.seed.name, props.seed.config))
    const [error, setError] = useState<string | null>(null)
    const [available, setAvailable] = useState<CredentialModel[]>([])
    const [filter, setFilter] = useState('')
    const [newModel, setNewModel] = useState('')
    const [importMachineId, setImportMachineId] = useState('')
    const [importAgent, setImportAgent] = useState<CredentialAgent>('codex')
    const saveMutation = useSaveCredential(props.api)
    const discoverMutation = useDiscoverCredentialModels(props.api)
    const readMutation = useReadMachineCredentials(props.api)

    const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
    const agents = compatibleCredentialAgents({ endpoints: draftEndpoints(draft) })
    const selectedIds = useMemo(() => new Set(draft.models.map((model) => model.id)), [draft.models])
    const candidates = available.filter((model) => !selectedIds.has(model.id)
        && model.id.toLowerCase().includes(filter.trim().toLowerCase()))

    const addModels = (models: CredentialModel[]) => {
        const fresh = models.filter((model) => !selectedIds.has(model.id))
        if (fresh.length === 0) return
        update({ models: [...draft.models, ...fresh], defaultModel: draft.defaultModel || fresh[0].id })
    }
    const removeModel = (id: string) => {
        const models = draft.models.filter((model) => model.id !== id)
        update({ models, defaultModel: draft.defaultModel === id ? models[0]?.id ?? '' : draft.defaultModel })
    }
    const setModel = (id: string, patch: Partial<CredentialModel>) =>
        update({ models: draft.models.map((model) => model.id === id ? { ...model, ...patch } : model) })

    const discover = async () => {
        setError(null)
        try {
            const result = await discoverMutation.mutateAsync({
                apiKey: draft.apiKey,
                endpoints: draftEndpoints(draft),
                headers: parseHeaders(draft.headers)
            })
            setAvailable(result.models)
            // Refresh metadata of models that are already selected.
            const fetched = new Map(result.models.map((model) => [model.id, model]))
            setDraft((current) => ({ ...current, models: current.models.map((model) => ({ ...fetched.get(model.id), ...model })) }))
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unable to list models')
        }
    }

    const importFromMachine = async () => {
        setError(null)
        try {
            const result = await readMutation.mutateAsync({ machineId: importMachineId, agent: importAgent })
            if (!result.success || !result.config) throw new Error(result.error ?? 'Nothing to import')
            setDraft(toDraft(draft.name || result.config.provider, result.config))
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Import failed')
        }
    }

    const save = async () => {
        setError(null)
        if (!draft.name.trim()) {
            setError('Name is required')
            return
        }
        const parsed = CredentialConfigSchema.safeParse({
            provider: draft.provider.trim(),
            apiKey: draft.apiKey.trim(),
            endpoints: draftEndpoints(draft),
            headers: parseHeaders(draft.headers),
            models: draft.models,
            defaultModel: draft.defaultModel
        })
        if (!parsed.success) {
            const issue = parsed.error.issues[0]
            setError(`${issue.path.join('.') || 'config'}: ${issue.message}`)
            return
        }
        try {
            await saveMutation.mutateAsync({ id: props.seed.id, name: draft.name.trim(), config: parsed.data })
            props.onClose()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to save')
        }
    }

    const sectionLabel = 'text-xs text-[var(--app-hint)]'
    return (
        <div className="border-b border-[var(--app-divider)] px-3 py-3 space-y-3">
            <div className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                {props.seed.id ? 'Edit Credential' : 'New Credential'}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
                <input className={inputClass} placeholder="Display name" value={draft.name}
                    onChange={(e) => update({ name: e.target.value })} />
                <input className={inputClass} placeholder="Provider ID (e.g. openrouter)" value={draft.provider}
                    onChange={(e) => update({ provider: e.target.value })} />
                <input className={`${inputClass} sm:col-span-2 font-mono`} type="password" autoComplete="off" placeholder="API key"
                    value={draft.apiKey} onChange={(e) => update({ apiKey: e.target.value })} />
            </div>

            <div className="space-y-1.5">
                <div className={sectionLabel}>
                    Endpoints · usable by {agents.length > 0 ? agents.map((agent) => AGENT_LABELS[agent]).join(', ') : 'no agent yet'}
                </div>
                {draft.endpoints.map((endpoint, index) => (
                    <div key={index} className="flex gap-2">
                        <select className={inputClass} aria-label="Protocol" value={endpoint.protocol}
                            onChange={(e) => update({ endpoints: draft.endpoints.map((item, i) => i === index ? { ...item, protocol: e.target.value as ModelProtocol } : item) })}>
                            {MODEL_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{PROTOCOL_LABELS[protocol]}</option>)}
                        </select>
                        <input className={`${inputClass} min-w-0 flex-1 font-mono`} placeholder="Base URL" value={endpoint.url}
                            onChange={(e) => update({ endpoints: draft.endpoints.map((item, i) => i === index ? { ...item, url: e.target.value } : item) })} />
                        <button type="button" className={secondaryButtonClass} aria-label="Remove endpoint"
                            onClick={() => update({ endpoints: draft.endpoints.filter((_, i) => i !== index) })}>×</button>
                    </div>
                ))}
                <button type="button" className={secondaryButtonClass}
                    disabled={draft.endpoints.length >= MODEL_PROTOCOLS.length}
                    onClick={() => update({ endpoints: [...draft.endpoints, {
                        protocol: MODEL_PROTOCOLS.find((protocol) => !draft.endpoints.some((item) => item.protocol === protocol)) ?? 'openai-responses',
                        url: ''
                    }] })}>Add endpoint</button>
            </div>

            <div className="space-y-1.5">
                <div className={sectionLabel}>Extra headers (optional, one "Name: value" per line)</div>
                <textarea className={`${inputClass} w-full font-mono text-xs`} rows={2} value={draft.headers}
                    onChange={(e) => update({ headers: e.target.value })} />
            </div>

            <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                    <div className={`${sectionLabel} flex-1`}>Models · the selected one is the default</div>
                    <button type="button" className={secondaryButtonClass} onClick={discover}
                        disabled={discoverMutation.isPending || !draft.apiKey.trim() || Object.keys(draftEndpoints(draft)).length === 0}>
                        {discoverMutation.isPending ? 'Fetching...' : 'Fetch from API'}
                    </button>
                </div>
                {draft.models.length === 0 && <div className="text-xs text-[var(--app-hint)]">No models yet</div>}
                {draft.models.map((model) => (
                    <div key={model.id} className="flex items-center gap-2">
                        <input type="radio" name="default-model" aria-label={`Default ${model.id}`}
                            checked={draft.defaultModel === model.id} onChange={() => update({ defaultModel: model.id })} />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={model.name ?? model.id}>{model.id}</span>
                        <input className={`${inputClass} w-28 text-xs`} type="number" min={1} placeholder="Context"
                            aria-label={`Context window for ${model.id}`} value={model.contextWindow ?? ''}
                            onChange={(e) => setModel(model.id, { contextWindow: e.target.value ? Number(e.target.value) : undefined })} />
                        <button type="button" className={secondaryButtonClass} aria-label={`Remove ${model.id}`}
                            onClick={() => removeModel(model.id)}>×</button>
                    </div>
                ))}
                <div className="flex gap-2">
                    <input className={`${inputClass} min-w-0 flex-1 font-mono`} placeholder="Add model ID" value={newModel}
                        onChange={(e) => setNewModel(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter' || !newModel.trim()) return
                            e.preventDefault()
                            addModels([{ id: newModel.trim() }])
                            setNewModel('')
                        }} />
                    <button type="button" className={secondaryButtonClass} disabled={!newModel.trim()}
                        onClick={() => { addModels([{ id: newModel.trim() }]); setNewModel('') }}>Add</button>
                </div>
                {available.length > 0 && (
                    <div className="rounded-lg border border-[var(--app-border)] p-2 space-y-1.5">
                        <div className="flex gap-2">
                            <input className={`${inputClass} min-w-0 flex-1`} placeholder={`Filter ${available.length} fetched models`}
                                value={filter} onChange={(e) => setFilter(e.target.value)} />
                            <button type="button" className={secondaryButtonClass} disabled={candidates.length === 0}
                                onClick={() => addModels(candidates)}>Add all shown</button>
                        </div>
                        <div className="max-h-48 overflow-y-auto">
                            {candidates.map((model) => (
                                <button key={model.id} type="button" onClick={() => addModels([model])}
                                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-[var(--app-subtle-bg)]">
                                    <span className="min-w-0 flex-1 truncate font-mono">+ {model.id}</span>
                                    {model.contextWindow && <span className="text-[var(--app-hint)]">{Math.round(model.contextWindow / 1000)}k</span>}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {props.machines.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                    <select className={`${inputClass} flex-1`} value={importMachineId} onChange={(e) => setImportMachineId(e.target.value)}>
                        <option value="">Import from machine...</option>
                        {props.machines.map((machine) => (
                            <option key={machine.id} value={machine.id}>{machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id}</option>
                        ))}
                    </select>
                    <select className={inputClass} aria-label="Import from agent" value={importAgent}
                        onChange={(e) => setImportAgent(e.target.value as CredentialAgent)}>
                        {CREDENTIAL_AGENTS.map((agent) => <option key={agent} value={agent}>{AGENT_LABELS[agent]} config</option>)}
                    </select>
                    <button type="button" className={secondaryButtonClass} onClick={importFromMachine}
                        disabled={!importMachineId || readMutation.isPending}>
                        {readMutation.isPending ? 'Reading...' : 'Import'}
                    </button>
                </div>
            )}

            {error && <div className="text-xs text-red-500">{error}</div>}
            <div className="flex gap-2">
                <button type="button" className={primaryButtonClass} onClick={save} disabled={saveMutation.isPending}>
                    {saveMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                <button type="button" className={secondaryButtonClass} onClick={props.onClose}>Cancel</button>
            </div>
        </div>
    )
}
