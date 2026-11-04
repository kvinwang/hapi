import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import SharedThreadPage from './shared-thread'

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ shareToken: 'public-test' }) }))
vi.mock('@/hooks/useServerUrl', () => ({ getPublicContentBaseUrl: () => 'https://owning-hub.example' }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('renders shared Markdown without login, write controls, favorites or member-session links, and hides revoked content', async () => {
    const info = vi.spyOn(ApiClient, 'getSharedThread').mockResolvedValue({ thread: { id: 't', name: 'Shared review', description: '', archived: true, createdAt: 1 }, members: [{ id: 'worker', kind: 'session', name: 'Reviewer' }] })
    vi.spyOn(ApiClient, 'getSharedThreadMessages').mockResolvedValue({ messages: [{ id: 'm', threadId: 't', seq: 1, sender: { kind: 'session', sessionId: 'worker' }, text: '**Public message**', mentions: [], receipts: [], createdAt: 1 }], hasMore: false })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><SharedThreadPage /></I18nProvider></QueryClientProvider>)
    expect((await screen.findByText('Public message')).tagName).toBe('STRONG')
    expect(info).toHaveBeenCalledWith('https://owning-hub.example', 'public-test')
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore thread' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save as quick phrase' })).toBeNull()
    expect(document.querySelector('a[href*="/sessions/"]')).toBeNull()
    info.mockRejectedValue(new Error('HTTP 404'))
    await client.invalidateQueries({ queryKey: ['shared-thread'] })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('Public message')).toBeNull()
    client.clear()
})
it('loads older shared messages without exposing private APIs', async () => {
    vi.spyOn(ApiClient, 'getSharedThread').mockResolvedValue({ thread: { id: 't', name: 'Shared review', description: '', archived: false, createdAt: 1 }, members: [] })
    const history = vi.spyOn(ApiClient, 'getSharedThreadMessages').mockImplementation(async (_base, _token, before) => ({
        messages: [{ id: before ? 'old' : 'new', threadId: 't', seq: before ? 1 : 2, sender: { kind: 'user' }, text: before ? 'Earlier public message' : 'Latest public message', mentions: [], receipts: [], createdAt: 1 }], hasMore: !before
    }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><SharedThreadPage /></I18nProvider></QueryClientProvider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Load older messages' }))
    expect(await screen.findByText('Earlier public message')).toBeTruthy()
    expect(screen.getByText('Latest public message')).toBeTruthy()
    await waitFor(() => expect(history).toHaveBeenCalledWith('https://owning-hub.example', 'public-test', 2))
    client.clear()
})
