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

function renderMenu() {
    const onFavoriteLists = vi.fn()
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
                onFavoriteLists={onFavoriteLists}
                anchorPoint={{ x: 100, y: 100 }}
            />
        </I18nProvider>
    )
    return { onFavoriteLists, onClose }
}

describe('SessionActionMenu favorites', () => {
    it('opens the favorite lists for an inactive session and closes the menu', () => {
        const { onFavoriteLists, onClose } = renderMenu()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Favorite lists…' }))
        expect(onFavoriteLists).toHaveBeenCalledOnce()
        expect(onClose).toHaveBeenCalledOnce()
    })
})
