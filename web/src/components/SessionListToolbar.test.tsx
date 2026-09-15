import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionListToolbar } from './SessionListToolbar'

beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
        value: { getItem: vi.fn(() => 'en'), setItem: vi.fn() }, configurable: true
    })
})
afterEach(cleanup)

function renderToolbar(overrides: Partial<React.ComponentProps<typeof SessionListToolbar>> = {}) {
    const actions = {
        onToggleArchived: vi.fn(), onToggleFavorites: vi.fn(), onNewSession: vi.fn(),
        onRefresh: vi.fn(), onToggleViewMode: vi.fn(), onCollapseAll: vi.fn(),
        onShared: vi.fn(), onSettings: vi.fn()
    }
    render(<I18nProvider><SessionListToolbar hideArchived favoritesOnly={false} viewMode="grouped" isRefreshing={false} {...actions} {...overrides} /></I18nProvider>)
    return actions
}

function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
}

describe('SessionListToolbar', () => {
    it('keeps only archive visibility, new session, favorites, and more outside the menu', () => {
        const actions = renderToolbar()
        expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
            'Show archived sessions', 'New Session', 'Favorites only', 'More actions'
        ])
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Favorites only' }))
        fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
        fireEvent.click(screen.getByRole('button', { name: 'Show archived sessions' }))
        expect(actions.onToggleFavorites).toHaveBeenCalledOnce()
        expect(actions.onNewSession).toHaveBeenCalledOnce()
        expect(actions.onToggleArchived).toHaveBeenCalledOnce()
    })

    it('exposes the active favorites filter and preserves the drawer back button', () => {
        const onCloseSidebar = vi.fn()
        renderToolbar({ favoritesOnly: true, onCloseSidebar })
        expect(screen.getByRole('button', { name: 'Favorites only' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Hide session sidebar' }))
        expect(onCloseSidebar).toHaveBeenCalledOnce()
    })

    it('moves every secondary action into the dropdown and closes after selection', () => {
        const actions = renderToolbar()
        const expected = ['Refresh sessions', 'Flat view', 'Collapse all', 'Shared Sessions', 'Settings']
        for (const [index, action] of [actions.onRefresh, actions.onToggleViewMode, actions.onCollapseAll, actions.onShared, actions.onSettings].entries()) {
            openMenu()
            expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(expected)
            fireEvent.click(screen.getByRole('menuitem', { name: expected[index] }))
            expect(action).toHaveBeenCalledOnce()
            expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        }
    })

    it('supports keyboard navigation, Escape, and outside dismissal', () => {
        renderToolbar()
        const trigger = screen.getByRole('button', { name: 'More actions' })
        fireEvent.keyDown(trigger, { key: 'ArrowDown' })
        const items = screen.getAllByRole('menuitem')
        expect(items[0]).toHaveFocus()
        fireEvent.keyDown(items[0], { key: 'ArrowDown' })
        expect(items[1]).toHaveFocus()
        fireEvent.keyDown(items[1], { key: 'End' })
        expect(items.at(-1)).toHaveFocus()
        fireEvent.keyDown(items.at(-1)!, { key: 'Escape' })
        expect(trigger).toHaveFocus()
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        openMenu()
        fireEvent.pointerDown(document.body)
        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('disables refresh while pending and offers grouped view when flat', () => {
        renderToolbar({ isRefreshing: true, viewMode: 'flat' })
        openMenu()
        expect(screen.getByRole('menuitem', { name: 'Refreshing…' })).toBeDisabled()
        expect(screen.getByRole('menuitem', { name: 'Grouped view' })).toHaveFocus()
    })
})
