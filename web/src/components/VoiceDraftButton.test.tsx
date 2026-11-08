import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OPEN_VOICE_PANEL } from '@/hooks/useVoicePanelSettings'
import { PanelSections } from './Session/PanelSections'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); localStorage.clear() })

it('adds a draft button to existing collapsed toolbar layouts and requests opening without speech', () => {
    localStorage.setItem('hapi.panelLayout', JSON.stringify([['voice'], ['chat', 'refresh']]))
    const open = vi.fn()
    window.addEventListener(OPEN_VOICE_PANEL, open)
    try {
        render(<PanelSections items={{ voice: <button>Microphone</button> }} expanded={false} />)
        fireEvent.click(screen.getByRole('button', { name: 'voice.ui.openDraft' }))
        expect(open).toHaveBeenCalledOnce()
    } finally {
        window.removeEventListener(OPEN_VOICE_PANEL, open)
    }
})

it('does not expose the draft button when voice controls are unavailable', () => {
    render(<PanelSections items={{}} expanded />)
    expect(screen.queryByRole('button', { name: 'voice.ui.openDraft' })).not.toBeInTheDocument()
})
