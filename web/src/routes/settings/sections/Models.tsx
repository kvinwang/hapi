import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useCredentials } from '@/hooks/queries/useCredentials'
import type { ModelPricing } from '@/types/api'
import { SettingsLinkRow, SettingsSection } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'

const pricingInputClass = 'min-w-0 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs'

function SystemPromptEditor() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { data: preferences } = useQuery({
        queryKey: queryKeys.preferences,
        queryFn: () => api.getPreferences()
    })
    const [globalPrompt, setGlobalPrompt] = useState('')
    const [initialized, setInitialized] = useState(false)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)

    useEffect(() => {
        if (preferences && !initialized) {
            setGlobalPrompt(preferences.systemPrompt)
            setInitialized(true)
        }
    }, [preferences, initialized])

    const changed = initialized && globalPrompt !== (preferences?.systemPrompt ?? '')

    const save = useCallback(async () => {
        setSaving(true)
        setSaved(false)
        try {
            const result = await api.updatePreferences({ systemPrompt: globalPrompt })
            setGlobalPrompt(result.systemPrompt)
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
        } finally {
            setSaving(false)
        }
    }, [api, globalPrompt])

    return (
        <div className="px-3 pb-3">
            <textarea
                value={globalPrompt}
                onChange={(e) => setGlobalPrompt(e.target.value)}
                placeholder={t('settings.systemPrompt.placeholder')}
                className="max-h-[300px] min-h-[100px] w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"
                maxLength={10000}
                rows={4}
                disabled={saving}
            />
            {(changed || saved) && (
                <div className="mt-2 flex justify-end">
                    {saved ? (
                        <span className="text-sm text-[var(--app-link)]">{t('settings.systemPrompt.saved')}</span>
                    ) : (
                        <button
                            type="button"
                            onClick={save}
                            disabled={saving}
                            className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                        >
                            {saving ? t('dialog.properties.saving') : t('button.save')}
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}

function ModelPricingEditor() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { data: pricingData, refetch: refetchPricing } = useQuery({
        queryKey: ['model-pricing'],
        queryFn: () => api.listModelPricing()
    })
    const [draft, setDraft] = useState({ model: '', input: '', output: '', cached: '' })
    const [saving, setSaving] = useState(false)

    const save = useCallback(async () => {
        const inputPerMillion = Number(draft.input)
        const outputPerMillion = Number(draft.output)
        const cachedInputPerMillion = Number(draft.cached)
        if (!draft.model.trim() || ![inputPerMillion, outputPerMillion, cachedInputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) return
        setSaving(true)
        try {
            await api.setModelPricing(draft.model.trim(), { inputPerMillion, outputPerMillion, cachedInputPerMillion })
            setDraft({ model: '', input: '', output: '', cached: '' })
            await refetchPricing()
        } finally {
            setSaving(false)
        }
    }, [api, draft, refetchPricing])

    const remove = useCallback(async (pricing: ModelPricing) => {
        await api.deleteModelPricing(pricing.model)
        await refetchPricing()
    }, [api, refetchPricing])

    return (
        <div className="space-y-2 px-3 pb-3">
            {(pricingData?.pricing ?? []).map((pricing) => (
                <div key={pricing.model} className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium">{pricing.model}</span>
                    <span className="tabular-nums text-[var(--app-hint)]">${pricing.inputPerMillion} / ${pricing.outputPerMillion} / ${pricing.cachedInputPerMillion}</span>
                    <button type="button" onClick={() => void remove(pricing)} className="text-red-500">{t('button.delete')}</button>
                </div>
            ))}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input value={draft.model} onChange={(e) => setDraft((value) => ({ ...value, model: e.target.value }))} placeholder={t('settings.modelPricing.model')} className={`${pricingInputClass} col-span-2 sm:col-span-1`} />
                <input type="number" min="0" step="any" value={draft.input} onChange={(e) => setDraft((value) => ({ ...value, input: e.target.value }))} placeholder={t('settings.modelPricing.input')} className={pricingInputClass} />
                <input type="number" min="0" step="any" value={draft.output} onChange={(e) => setDraft((value) => ({ ...value, output: e.target.value }))} placeholder={t('settings.modelPricing.output')} className={pricingInputClass} />
                <input type="number" min="0" step="any" value={draft.cached} onChange={(e) => setDraft((value) => ({ ...value, cached: e.target.value }))} placeholder={t('settings.modelPricing.cached')} className={pricingInputClass} />
            </div>
            <div className="flex justify-end">
                <button type="button" disabled={saving || !draft.model.trim()} onClick={() => void save()} className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">{t('button.save')}</button>
            </div>
        </div>
    )
}

export default function ModelsSettings() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { api } = useAppContext()
    const { credentials, isLoading } = useCredentials(api, true)

    return (
        <SettingsScreen title={t('settings.group.models')}>
            <SettingsSection description={t('settings.providers.description')}>
                <SettingsLinkRow
                    label={t('settings.nav.providers')}
                    value={isLoading ? undefined : String(credentials.length)}
                    onClick={() => navigate({ to: '/settings/models/providers' })}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.systemPrompt.title')} description={t('settings.systemPrompt.description')}>
                <SystemPromptEditor />
            </SettingsSection>
            <SettingsSection title={t('settings.modelPricing.title')} description={t('settings.modelPricing.description')}>
                <ModelPricingEditor />
            </SettingsSection>
        </SettingsScreen>
    )
}
