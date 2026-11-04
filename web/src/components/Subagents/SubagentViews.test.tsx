import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SubagentsChip } from './SubagentViews'
import type { SubagentEntry } from '@hapi/protocol/types'

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('puts running agents first and reorders immediately when their status changes', () => {
    const entries: Record<string, SubagentEntry> = {
        completed: { sessionId: 'done', description: 'Newest completed', status: 'completed', startedAt: 30 },
        first: { sessionId: 'first', description: 'Older running', status: 'running', startedAt: 10 },
        second: { sessionId: 'second', description: 'Newer running', status: 'running', startedAt: 20 }
    }
    const view = (active: boolean) => <I18nProvider><SubagentsChip entries={entries} ownerActive={active} onOpen={() => {}} /></I18nProvider>
    const { rerender } = render(view(true))
    fireEvent.click(screen.getByRole('button'))
    const names = () => within(screen.getByRole('region')).getAllByRole('button').map(button => button.querySelector('span')?.textContent)
    expect(names()).toEqual(['Newer running', 'Older running', 'Newest completed'])
    const search = screen.getByRole('searchbox', { name: 'Search agents…' })
    fireEvent.change(search, { target: { value: ' RUNNING ' } })
    expect(names()).toEqual(['Newer running', 'Older running'])
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText('No matching agents')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    entries.second.status = 'completed'
    rerender(view(true))
    expect(names()).toEqual(['Older running', 'Newest completed', 'Newer running'])
    rerender(view(false))
    expect(names()).toEqual(['Newest completed', 'Newer running', 'Older running'])
})
