import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionThreadsChip } from './SessionThreadsChip'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, params, search, onClick }: { children: ReactNode; params: { threadId: string }; search: { fromSession: string }; onClick: () => void }) => <a href={`/threads/${params.threadId}?fromSession=${search.fromSession}`} onClick={onClick}>{children}</a> }))
afterEach(() => { cleanup(); localStorage.removeItem('hapi-threads-hide-archived') })
it('shows joined threads and session unread counts, and follows membership updates', async () => {
    let threads = [{ id: 'g1', name: 'Implementation', description: 'Shared work', unread: 3, archived: false }]
    const request = vi.fn(async (_path: string) => ({ threads }))
    const api = { threadRequest: request } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><SessionThreadsChip api={api} sessionId="s1" /></I18nProvider></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Threads 1/ }))
    expect(request).toHaveBeenCalledWith('?sessionId=s1')
    expect(screen.getByRole('link', { name: /Implementation/ })).toHaveAttribute('href', '/threads/g1?fromSession=s1')
    expect(screen.getByText('3 unread for this session')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    threads = []
    await client.invalidateQueries({ queryKey: ['threads'] })
    await waitFor(() => expect(screen.queryByRole('button', { name: /Threads/ })).toBeNull())
    expect(request.mock.calls.every(call => call[0] !== '/consume')).toBe(true)
    client.clear()
})

it('keeps archived memberships accessible behind the archive filter', async () => {
    const api = { threadRequest: async () => ({ threads: [{ id: 'old', name: 'Old discussion', archived: true, unread: 0 }] }) } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><SessionThreadsChip api={api} sessionId="s1" /></I18nProvider></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /Threads 0/ }))
    expect(screen.queryByRole('link', { name: /Old discussion/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
    expect(screen.getByRole('link', { name: /Old discussion/ })).toBeTruthy()
    client.clear()
})
