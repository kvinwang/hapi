import { describe, expect, it } from 'vitest'
import { getCodexModelOptions } from './codexModelOptions'
import { MODEL_OPTIONS } from '@/components/NewSession/types'

describe('getCodexModelOptions', () => {
    it('replaces hardcoded models with the detected catalog', () => {
        expect(getCodexModelOptions({
            models: [{ value: 'account-model', displayName: 'Account Model', description: 'Available here' }],
            currentModel: 'auto'
        })).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'account-model', label: 'Account Model', description: 'Available here' }
        ])
    })

    it.each([null, undefined, []])('uses static fallback without a catalog (%s)', (models) => {
        expect(getCodexModelOptions({ models, currentModel: 'auto' }))
            .toEqual(MODEL_OPTIONS.codex)
    })

    it('preserves an unlisted current model after switching machines', () => {
        expect(getCodexModelOptions({
            models: [{ value: 'other-model', displayName: 'Other Model' }],
            currentModel: 'custom-model'
        }).at(-1)).toEqual({ value: 'custom-model', label: 'custom-model' })
    })

    it('does not duplicate catalog entries or the automatic option', () => {
        expect(getCodexModelOptions({
            models: [
                { value: 'auto', displayName: 'Automatic' },
                { value: 'model', displayName: 'Model' },
                { value: 'model', displayName: 'Model' }
            ], currentModel: 'model'
        })).toHaveLength(2)
    })
})
