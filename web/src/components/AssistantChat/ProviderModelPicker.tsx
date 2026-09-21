import type { CodexProviderRef } from '@hapi/protocol/schemas'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Metadata } from '@hapi/protocol/types'

/** Credential material never enters the picker; the hub resolves IDs server-side. */
export function ProviderModelPicker(props: {
    api: ApiClient
    sessionId: string
    provider?: Metadata['codexProvider'] | Metadata['piProvider']
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
    const options = [
        ...props.models.map((model) => ({ provider: currentProvider, name: currentName, model: model.mode, label: model.label })),
        ...(currentProvider.source !== 'default' ? [{ provider: { source: 'default' as const }, name: 'Machine default', model: 'auto', label: 'Auto' }] : []),
        ...(providers.data?.providers ?? []).filter((provider) => JSON.stringify(provider.provider) !== currentId)
            .map((provider) => ({ ...provider, label: provider.model === 'auto' ? 'Auto' : provider.model }))
    ]
    const optionLabel = (option: typeof options[number]): string => {
        const label = `${option.name} / ${option.label}`
        const ambiguous = options.some((other) => other.name === option.name
            && other.label === option.label && JSON.stringify(other.provider) !== JSON.stringify(option.provider))
        if (!ambiguous) return label
        const source = option.provider.source === 'profile' ? 'Local profile'
            : option.provider.source === 'credential' ? 'Agent credential' : 'Machine default'
        return `${label} (${source})`
    }
    return <div className="py-2">
        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">Provider / Model</div>
        {options.map((option) => <button
            key={JSON.stringify([option.provider, option.model])}
            type="button"
            disabled={props.disabled || pending || (props.providerSwitchDisabled && JSON.stringify(option.provider) !== currentId)}
            aria-pressed={JSON.stringify(option.provider) === currentId && option.model === props.model}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 aria-pressed:text-[var(--app-link)]"
            onClick={() => void select(option.provider, option.model)}
            onMouseDown={(event) => event.preventDefault()}
        >{optionLabel(option)}</button>)}
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
