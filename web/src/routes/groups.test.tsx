import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GroupsPage from './groups'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { groupRequest: mocks.request } }) }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [] }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Groups page', () => {
    it('confirms only the human reader and sends explicit mentions', async () => {
        let readAt: number | null = null
        const group = { id: 'g', name: 'Review', description: '', archived: false, wakeCount: 0, wakeLimit: 20, createdAt: 1, unread: 1 }
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path === '') return { groups: [group] }
            if (path === '/g') return { group, members: [{ id: 'worker', kind: 'session', title: 'Worker', mentionWake: true, status: 'idle' }] }
            if (path.startsWith('/g/history')) return { messages: [{ id: 'm', groupId: 'g', seq: 1, sender: { kind: 'session', sessionId: 'worker' }, text: 'Implementation ready', mentions: [], createdAt: 1, receipts: [{ memberId: 'user', readAt, deliveredAt: null, wakeStatus: null, reason: null }] }], hasMore: false }
            if (path === '/consume') { readAt = 1; return { ok: true } }
            if (path === '/g/send') return { message: body }
            throw new Error(`Unexpected request: ${path}`)
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        render(<QueryClientProvider client={client}><GroupsPage /></QueryClientProvider>)
        fireEvent.click(await screen.findByRole('button', { name: 'Review (1)' }))
        expect(await screen.findByText('Implementation ready')).toBeTruthy()
        await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/consume', { ids: ['m'] }))
        fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Please review.' } })
        fireEvent.click(screen.getByRole('checkbox', { name: 'Worker' }))
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/g/send', expect.objectContaining({ text: 'Please review.', mentions: ['worker'] })))
        client.clear()
    })
})
