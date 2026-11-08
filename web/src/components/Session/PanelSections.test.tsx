import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PanelSections } from './PanelSections'

afterEach(() => { cleanup(); localStorage.clear() })

it('discards removed toolbar items without resetting the remaining layout', () => {
    localStorage.setItem('hapi.panelLayout', JSON.stringify([['terminal', 'refresh'], ['chat', 'sessions']]))
    const { container } = render(<PanelSections expanded items={{
        terminal: <button>Terminal</button>, chat: <button>Chat</button>, sessions: <button>Sessions</button>,
    }} />)
    expect(container.querySelector('[data-panel-item="refresh"]')).toBeNull()
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Terminal', 'Chat', 'Sessions'])
    expect(container.querySelector('[data-panel-section="0"] [data-panel-item="terminal"]')).not.toBeNull()
    expect(container.querySelector('[data-panel-section="1"] [data-panel-item="chat"]')).not.toBeNull()
})
