import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { GuestAccessDialog } from './GuestAccessDialog'

vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }) }))
afterEach(cleanup)
it('creates scoped guest access and updates existing codes without enabling unrelated threads', async () => {
    const grant = {
        id: 'grant',
        description: 'Reviewer',
        allowVoice: false,
        allowAgents: false,
        threadIds: [] as string[],
        createdAt: 1,
        expiresAt: Date.now() + 3600000
    }
    const createGuestGrant = vi.fn(async () => ({ grant, code: 'TEST2345' }))
    const updateGuestScope = vi.fn(async (_session, _id, options) => ({ grant: { ...grant, ...options } }))
    const api = {
        listGuestGrants: async () => ({ grants: [grant] }),
        threadRequest: async () => ({ threads: [{ id: 'thread-a', name: 'API review' }] }),
        createGuestGrant,
        updateGuestScope
    } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <I18nProvider>
                <GuestAccessDialog api={api} sessionId="root" onClose={() => {}} />
            </I18nProvider>
        </QueryClientProvider>
    )
    const agents = screen.getByRole('checkbox', { name: 'Allow viewing subagent conversations' })
    expect(agents).not.toBeChecked()
    fireEvent.click(agents)
    const thread = await screen.findAllByRole('checkbox', { name: 'API review' })
    fireEvent.click(thread[0])
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    await waitFor(() =>
        expect(createGuestGrant).toHaveBeenCalledWith(
            'root',
            expect.objectContaining({ allowAgents: true, threadIds: ['thread-a'], allowVoice: false })
        )
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Agents' }))
    await waitFor(() =>
        expect(updateGuestScope).toHaveBeenCalledWith('root', 'grant', { allowAgents: true, threadIds: undefined })
    )
    client.clear()
})
