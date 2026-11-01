import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOrb'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); localStorage.clear() })

describe('voice draft feedback', () => {
    it('keeps an empty failed draft panel visible with a reason and a dismiss action', () => {
        const clear = vi.fn()
        render(<VoiceOverlay caption={null} draft="" drafting={false} sending={false}
            draftIssue={{ reason: 'service', detail: 'Audio transcription unavailable' }} onClear={clear} onSend={vi.fn()} />)
        expect(screen.getByRole('status')).toHaveTextContent('Audio transcription unavailable')
        expect(screen.getByRole('button', { name: 'voice.omni.draft.send' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'voice.omni.draft.clear' }))
        expect(clear).toHaveBeenCalledOnce()
    })
})


it('remembers auto-send and the selected pause in the draft panel', () => {
    const props = { caption: null, draft: 'Draft', drafting: false, sending: false, onSend: vi.fn(), onClear: vi.fn() }
    const first = render(<VoiceOverlay {...props} />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '5' } })
    first.unmount()
    render(<VoiceOverlay {...props} />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByRole('combobox')).toHaveValue('5')
    expect(screen.getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['2', '3', '5'])
})
