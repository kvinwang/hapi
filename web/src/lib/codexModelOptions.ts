import type { CodexModelInfo } from '@hapi/protocol/types'
import { MODEL_OPTIONS } from '@/components/NewSession/types'

type ModelOption = { value: string; label: string; description?: string }

/** Shared by new-session and in-session pickers; discovered catalogs replace static entries. */
export function getCodexModelOptions(options: {
    models?: CodexModelInfo[] | null
    currentModel: string
}): ModelOption[] {
    const models = options.models?.length
        ? options.models.map((model) => ({
            value: model.value,
            label: model.displayName,
            description: model.description
        }))
        : MODEL_OPTIONS.codex.filter((model) => model.value !== 'auto')
    const result: ModelOption[] = [{ value: 'auto', label: 'Auto' }]
    for (const model of models) {
        if (!result.some((entry) => entry.value === model.value)) result.push(model)
    }
    if (options.currentModel && !result.some((entry) => entry.value === options.currentModel)) {
        result.push({ value: options.currentModel, label: options.currentModel === 'default' ? 'Default' : options.currentModel })
    }
    return result
}
