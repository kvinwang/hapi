import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ModelSelector } from './ModelSelector'

afterEach(cleanup)

describe('ModelSelector', () => {
    it('uses the selected provider models instead of detected or static agent models', () => {
        render(<I18nProvider>
            <ModelSelector agent="claude" model="provider-model" isDisabled={false} onModelChange={() => {}}
                providerModels={[{ id: 'provider-model' }, { id: 'provider-model-2' }]}
                detectedClaudeModels={[{ value: 'opus', displayName: 'Opus' }]} />
        </I18nProvider>)

        const options = [...(screen.getByRole('combobox') as HTMLSelectElement).options].map((option) => option.value)
        expect(options).toEqual(['provider-model', 'provider-model-2'])
    })
})
