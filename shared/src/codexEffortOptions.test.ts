import { describe, expect, it } from 'bun:test'
import { getCodexEffortOptions } from './codexEffortOptions'
import { EffortModeSchema, MetadataSchema } from './schemas'

const machineModels = [
    { value: 'model-a', displayName: 'A', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast responses' },
        { reasoningEffort: 'ultra', description: 'Thorough reasoning' }
    ] },
    { value: 'model-b', displayName: 'B', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }
]

describe('getCodexEffortOptions', () => {
    it('uses agent-provided levels and descriptions without a fixed allowlist', () => {
        expect(getCodexEffortOptions({ modelMode: 'model-a', machineModels })).toEqual([
            { mode: 'default', label: 'Default', description: 'Model default: Low' },
            { mode: 'low', label: 'Low', description: 'Fast responses' },
            { mode: 'ultra', label: 'ultra', description: 'Thorough reasoning' }
        ])
    })

    it('changes candidates on model selection, ignoring a stale resolved model', () => {
        const options = getCodexEffortOptions({ modelMode: 'model-b', resolvedModel: 'model-a', machineModels })
        expect(options.map((option) => option.mode)).toEqual(['default', 'medium'])
    })

    it('uses the resolved model when Auto is selected', () => {
        expect(getCodexEffortOptions({ modelMode: 'auto', resolvedModel: 'model-b', machineModels })
            .map((option) => option.mode)).toEqual(['default', 'medium'])
    })

    it('uses the agent default model before a model has been resolved', () => {
        expect(getCodexEffortOptions({ modelMode: 'auto', machineModels }).map((option) => option.mode))
            .toEqual(['default', 'low', 'ultra'])
    })

    it('prefers the live catalog over cached machine capabilities', () => {
        const agentModelCatalog = [{ id: 'model-a', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }]
        expect(getCodexEffortOptions({ modelMode: 'model-a', agentModelCatalog, machineModels }).map((option) => option.mode))
            .toEqual(['default', 'xhigh'])
    })

    it('falls back to machine capabilities when the live catalog omits efforts', () => {
        expect(getCodexEffortOptions({ modelMode: 'model-a', agentModelCatalog: [{ id: 'model-a' }], machineModels })
            .map((option) => option.mode)).toEqual(['default', 'low', 'ultra'])
    })

    it('does not substitute another model for an unknown explicit model', () => {
        expect(getCodexEffortOptions({ modelMode: 'custom-model', machineModels }).map((option) => option.mode))
            .toEqual(['default', 'low', 'medium', 'high', 'auto'])
    })

    it('offers only Default for an explicitly empty supported-efforts list', () => {
        const agentModelCatalog = [{ id: 'model-a', supportedReasoningEfforts: [] }]
        expect(getCodexEffortOptions({ modelMode: 'model-a', agentModelCatalog, machineModels }))
            .toEqual([{ mode: 'default', label: 'Default' }])
    })

    it('deduplicates levels, including the Default entry', () => {
        const agentModelCatalog = [{ id: 'model-a', supportedReasoningEfforts: [
            { reasoningEffort: 'default' }, { reasoningEffort: 'high' }, { reasoningEffort: 'high' }
        ] }]
        expect(getCodexEffortOptions({ modelMode: 'model-a', agentModelCatalog }).map((option) => option.mode))
            .toEqual(['default', 'high'])
    })

    it('preserves new effort IDs and capabilities through metadata validation', () => {
        const agentModelCatalog = [{ id: 'model-a', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], isDefault: true }]
        expect(EffortModeSchema.parse('ultra')).toBe('ultra')
        expect(EffortModeSchema.safeParse('').success).toBe(false)
        expect(MetadataSchema.parse({ path: '/tmp', host: 'test', effortMode: 'ultra', agentModelCatalog }))
            .toMatchObject({ effortMode: 'ultra', agentModelCatalog })
    })
})
