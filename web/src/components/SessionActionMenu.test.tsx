import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionActionMenu } from './SessionActionMenu'

beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
        value: { getItem: vi.fn(() => 'en'), setItem: vi.fn() },
        configurable: true
    })
})
afterEach(cleanup)

function renderMenu(favorite = false, favoritePending = false) {
    const onToggleFavorite = vi.fn()
    const onClose = vi.fn()
    render(
        <I18nProvider>
            <SessionActionMenu
                isOpen
                sessionId="session-1"
                sessionActive={false}
                onClose={onClose}
                onResume={vi.fn()}
                onArchive={vi.fn()}
                onDelete={vi.fn()}
                favorite={favorite}
                favoritePending={favoritePending}
                onToggleFavorite={onToggleFavorite}
                anchorPoint={{ x: 100, y: 100 }}
            />
        </I18nProvider>
    )
    return { onToggleFavorite, onClose }
}

describe('SessionActionMenu favorites', () => {
    it('allows favoriting an inactive session and closes the menu', () => {
        const { onToggleFavorite, onClose } = renderMenu()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to favorites' }))
        expect(onToggleFavorite).toHaveBeenCalledOnce()
        expect(onClose).toHaveBeenCalledOnce()
    })
    it('offers removal for an existing favorite', () => {
        const { onToggleFavorite } = renderMenu(true)
        fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from favorites' }))
        expect(onToggleFavorite).toHaveBeenCalledOnce()
    })
    it('prevents duplicate mutations while saving', () => {
        const { onToggleFavorite } = renderMenu(false, true)
        const button = screen.getByRole('menuitem', { name: 'Add to favorites' }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        fireEvent.click(button)
        expect(onToggleFavorite).not.toHaveBeenCalled()
    })
})
