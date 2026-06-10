import { useMemo } from 'react'
import type { AgentType } from './types'
import { MODEL_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export type DetectedClaudeModel = { value: string; displayName: string; description?: string }

export function ModelSelector(props: {
    agent: AgentType
    model: string
    isDisabled: boolean
    onModelChange: (value: string) => void
    /** Account-specific models detected on the selected machine (claude only). */
    detectedClaudeModels?: DetectedClaudeModel[] | null
}) {
    const { t } = useTranslation()
    const { agent, model, detectedClaudeModels } = props

    const options = useMemo(() => {
        let result: { value: string; label: string; description?: string }[]
        if (agent === 'claude' && detectedClaudeModels && detectedClaudeModels.length > 0) {
            // Claude Code reports a 'default' entry; hapi represents it as 'auto'.
            result = [
                { value: 'auto', label: 'Auto' },
                ...detectedClaudeModels
                    .filter((m) => m.value !== 'default')
                    .map((m) => ({ value: m.value, label: m.displayName, description: m.description }))
            ]
        } else {
            result = [...MODEL_OPTIONS[agent]]
        }
        // Keep the currently selected value visible even when it is not in the list
        // (e.g. the machine changed and reports a different model set).
        if (model && !result.some((option) => option.value === model)) {
            result.push({ value: model, label: model })
        }
        return result
    }, [agent, detectedClaudeModels, model])

    if (options.length === 0) {
        return null
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.model')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.model}
                onChange={(e) => props.onModelChange(e.target.value)}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value} title={option.description}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
