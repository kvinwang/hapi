import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { VoiceOverlay } from './VoiceOrb'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

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
