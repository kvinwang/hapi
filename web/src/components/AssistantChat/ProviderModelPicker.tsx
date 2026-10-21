import type { CodexProviderOption, CodexProviderRef } from '@hapi/protocol/schemas'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Metadata } from '@hapi/protocol/types'

type ProviderGroup = {
    provider: CodexProviderRef
    name: string
    models: Array<{ value: string; label: string }>
}

function sourceLabel(provider: CodexProviderRef): string {
    return provider.source === 'profile' ? 'Local profile'
        : provider.source === 'credential' ? 'Agent credential' : 'Machine default'
}

/** Credential material never enters the picker; the hub resolves IDs server-side. */
export function ProviderModelPicker(props: {
    api: ApiClient
    sessionId: string
    provider?: Metadata['codexProvider'] | Metadata['piProvider'] | Metadata['claudeProvider']
    model: string
    models: Array<{ mode: string; label: string; description?: string }>
    disabled: boolean
    providerSwitchDisabled: boolean
    onModelChange: (model: string) => void
}) {
    const queryClient = useQueryClient()
    const [customModel, setCustomModel] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const providers = useQuery({
        queryKey: ['session-providers', props.sessionId],
        queryFn: () => props.api.getSessionProviders(props.sessionId),
        retry: false
    })
    const currentProvider: CodexProviderRef = props.provider?.provider ?? { source: 'default' }
    const currentId = JSON.stringify(currentProvider)
    const currentName = props.provider?.name ?? 'Machine default'

    const groups = useMemo(() => {
        const map = new Map<string, ProviderGroup>()
        const add = (provider: CodexProviderRef, name: string, value: string, label: string) => {
            const key = JSON.stringify(provider)
            const group = map.get(key) ?? { provider, name, models: [] }
            if (!group.models.some((model) => model.value === value)) group.models.push({ value, label })
            map.set(key, group)
        }
        if (currentProvider.source === 'default') {
            for (const model of props.models) add(currentProvider, currentName, model.mode, model.label)
            add(currentProvider, currentName, 'auto', 'Auto')
        } else {
            add(currentProvider, currentName, props.model, props.model)
            add({ source: 'default' }, 'Machine default', 'auto', 'Auto')
        }
        for (const option of providers.data?.providers ?? [] as CodexProviderOption[]) {
            add(option.provider, option.name, option.model, option.model === 'auto' ? 'Auto' : option.model)
        }
        return [...map.values()]
    }, [currentProvider, currentName, props.model, props.models, providers.data])

    const ambiguousNames = new Set(groups.filter((group) => groups.filter((other) => other.name === group.name).length > 1)
        .map((group) => group.name))
    const groupLabel = (group: ProviderGroup) => ambiguousNames.has(group.name)
        ? `${group.name} (${sourceLabel(group.provider)})` : group.name
    const selectedGroup = groups.find((group) => JSON.stringify(group.provider) === currentId)
    const modelOptions = useMemo(() => {
        const options = selectedGroup?.models ?? []
        if (props.model && !options.some((option) => option.value === props.model)) {
            return [...options, { value: props.model, label: props.model }]
        }
        return options
    }, [selectedGroup, props.model])

    const select = async (provider: CodexProviderRef, model: string) => {
        if (JSON.stringify(provider) === currentId) {
            props.onModelChange(model)
            return
        }
        if (props.providerSwitchDisabled) return
        setPending(true)
        setError(null)
        try {
            await props.api.setSessionProvider(props.sessionId, provider, model)
            await queryClient.invalidateQueries()
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Unable to switch provider')
        } finally {
            setPending(false)
        }
    }

    const selectProvider = (value: string) => {
        const group = groups.find((item) => JSON.stringify(item.provider) === value)
        if (!group || JSON.stringify(group.provider) === currentId) return
        void select(group.provider, group.provider.source === 'default' ? 'auto' : group.models[0]?.value ?? 'auto')
    }

    return <div className="flex flex-col gap-2 py-2">
        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">Provider / Model</div>
        <div className="flex flex-col gap-1.5 px-3">
            <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--app-hint)]">Provider</span>
                <select
                    aria-label="Provider"
                    value={currentId}
                    disabled={props.disabled || pending || props.providerSwitchDisabled}
                    onChange={(event) => selectProvider(event.target.value)}
                    className="w-full rounded border border-[var(--app-border)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                >
                    {groups.map((group) => (
                        <option key={JSON.stringify(group.provider)} value={JSON.stringify(group.provider)}>
                            {groupLabel(group)}
                        </option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--app-hint)]">Model</span>
                <select
                    aria-label="Model"
                    value={props.model}
                    disabled={props.disabled || pending}
                    onChange={(event) => void select(currentProvider, event.target.value)}
                    className="w-full rounded border border-[var(--app-border)] bg-transparent px-2 py-1 text-sm disabled:opacity-50"
                >
                    {modelOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
            </label>
        </div>
        <div className="flex gap-2 px-3 py-2">
            <input aria-label="Custom model" placeholder="Custom model ID" value={customModel}
                disabled={props.disabled || pending}
                onChange={(event) => setCustomModel(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    event.stopPropagation()
                    if (!props.disabled && !pending && customModel.trim()) void select(currentProvider, customModel.trim())
                }}
                className="min-w-0 flex-1 rounded border border-[var(--app-border)] bg-transparent px-2 py-1 text-sm" />
            <button type="button" disabled={props.disabled || pending || !customModel.trim()}
                onClick={() => void select(currentProvider, customModel.trim())}
                className="text-sm text-[var(--app-link)] disabled:opacity-50">Apply</button>
        </div>
        {pending ? <div role="status" className="px-3 text-xs">Switching provider…</div> : null}
        {props.providerSwitchDisabled ? <div className="px-3 text-xs text-[var(--app-hint)]">Provider switching requires an idle remote session.</div> : null}
        {error ? <div role="alert" className="px-3 text-xs text-red-500">{error}</div> : null}
        {providers.isError ? <div className="px-3 text-xs text-[var(--app-hint)]">Provider list unavailable (administrator access required).</div> : null}
    </div>
}
