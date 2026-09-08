import { getEffortModeLabel, getEffortModesForFlavor } from './modes'
import type { CodexModelInfo, Metadata } from './schemas'

export type CodexEffortOption = { mode: string; label: string; description?: string }

/** Shared by the picker and API validation so model-specific options stay consistent. */
export function getCodexEffortOptions(input: {
    modelMode?: string | null
    resolvedModel?: string | null
    agentModelCatalog?: Metadata['agentModelCatalog'] | null
    machineModels?: CodexModelInfo[] | null
}): CodexEffortOption[] {
    const explicitModel = input.modelMode && input.modelMode !== 'auto' && input.modelMode !== 'default'
        ? input.modelMode
        : undefined
    // An explicit selection wins over stale resolved-model metadata from the previous turn.
    const modelId = explicitModel ?? input.resolvedModel
        ?? input.agentModelCatalog?.find((model) => model.isDefault)?.id
        ?? input.machineModels?.find((model) => model.isDefault)?.value
    const liveModel = input.agentModelCatalog?.find((model) => model.id === modelId)
    const machineModel = input.machineModels?.find((model) => model.value === modelId)
    const model = liveModel?.supportedReasoningEfforts !== undefined ? liveModel : machineModel
    if (model?.supportedReasoningEfforts === undefined) {
        return getEffortModesForFlavor('codex').map((mode) => ({ mode, label: getEffortModeLabel(mode) }))
    }

    const options: CodexEffortOption[] = [{
        mode: 'default',
        label: 'Default',
        ...(model.defaultReasoningEffort ? {
            description: `Model default: ${getEffortModeLabel(model.defaultReasoningEffort)}`
        } : {})
    }]
    for (const effort of model.supportedReasoningEfforts) {
        if (options.some((option) => option.mode === effort.reasoningEffort)) continue
        options.push({
            mode: effort.reasoningEffort,
            label: getEffortModeLabel(effort.reasoningEffort),
            description: effort.description
        })
    }
    // Only the candidates change. Never rewrite the user's selected effort here.
    return options
}
