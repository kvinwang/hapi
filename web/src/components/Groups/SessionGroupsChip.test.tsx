import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionGroupsChip } from './SessionGroupsChip'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, params, onClick }: { children: ReactNode; params: { groupId: string }; onClick: () => void }) => <a href={`/groups/${params.groupId}`} onClick={onClick}>{children}</a> }))
afterEach(cleanup)
it('shows joined groups and session unread counts, and follows membership updates', async () => {
    let groups = [{ id: 'g1', name: 'Implementation', description: 'Shared work', unread: 3, archived: false }]
    const request = vi.fn(async (_path: string) => ({ groups }))
    const api = { groupRequest: request } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><SessionGroupsChip api={api} sessionId="s1" /></I18nProvider></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Groups 1/ }))
    expect(request).toHaveBeenCalledWith('?sessionId=s1')
    expect(screen.getByRole('link', { name: /Implementation/ })).toHaveAttribute('href', '/groups/g1')
    expect(screen.getByText('3 unread for this session')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    groups = []
    await client.invalidateQueries({ queryKey: ['groups'] })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Groups/ })).toBeNull())
    expect(request.mock.calls.every(call => call[0] !== '/consume')).toBe(true)
    client.clear()
})
