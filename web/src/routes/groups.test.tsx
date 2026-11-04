import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GroupsPage from './groups'
import { GroupChat } from '@/components/Groups/GroupChat'

const mocks = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn() }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { groupRequest: mocks.request } }) }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [] }) }))
vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    Link: ({
        children,
        to,
        params,
        ...props
    }: {
        children: ReactNode
        to: string
        params?: Record<string, string>
    }) => (
        <a
            {...props}
            href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}
        >
            {children}
        </a>
    )
}))
afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})
const group = {
    id: 'g',
    name: 'Review',
    description: '',
    archived: false,
    wakeCount: 0,
    wakeLimit: 20,
    createdAt: 1,
    unread: 1
}
const members = [{ id: 'worker', kind: 'session', title: 'Worker', mentionWake: true, status: 'idle' }]
function setup() {
    let readAt: number | null = null
    mocks.request.mockImplementation(async (path: string, body?: unknown) => {
        if (path === '') return { groups: [group] }
        if (path === '/g') return { group, members }
        if (path.startsWith('/g/history'))
            return {
                messages: [
                    {
                        id: 'm',
                        groupId: 'g',
                        seq: 2,
                        sender: { kind: 'session', sessionId: 'worker' },
                        text: '**Implementation ready**',
                        mentions: [],
                        createdAt: 1,
                        receipts: [{ memberId: 'user', readAt, deliveredAt: null, wakeStatus: null, reason: null }]
                    }
                ],
                hasMore: false
            }
        if (path === '/consume') {
            readAt = 1
            return { ok: true }
        }
        if (path === '/g/send') return { message: body }
        throw new Error(`Unexpected request: ${path}`)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return {
        client,
        mount: (children: ReactNode) => render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
    }
}

describe('Group conversations', () => {
    it('links groups to dedicated conversations without putting creation in the chat', async () => {
        const { client, mount } = setup()
        mount(<GroupsPage />)
        expect(await screen.findByRole('link', { name: /Review/ })).toHaveAttribute('href', '/groups/g')
        expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /New group/ }))
        expect(await screen.findByRole('textbox', { name: 'Group name' })).toBeTruthy()
        client.clear()
    })

    it('renders markdown, confirms only the human reader, and sends explicit @mentions', async () => {
        const { client, mount } = setup()
        mount(<GroupChat groupId="g" fromSession="source-session" />)
        expect((await screen.findByText('Implementation ready')).tagName).toBe('STRONG')
        expect(screen.getByRole('link', { name: 'Back to session' })).toHaveAttribute('href', '/sessions/source-session')
        await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/consume', { ids: ['m'] }))
        const input = screen.getByRole('textbox', { name: 'Message' })
        fireEvent.change(input, { target: { value: '@Wor' } })
        fireEvent.click(await screen.findByRole('option', { name: /Worker/ }))
        expect(screen.getByRole('button', { name: 'Remove mention Worker' })).toBeTruthy()
        fireEvent.change(input, { target: { value: 'Please review.' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith(
                '/g/send',
                expect.objectContaining({ text: 'Please review.', mentions: ['worker'] })
            )
        )
        expect(screen.queryByRole('button', { name: 'Archive group' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Members & settings' }))
        expect(await screen.findByRole('button', { name: 'Archive group' })).toBeTruthy()
        client.clear()
    })

    it('keeps consecutive agent messages separate and supports keyboard mention selection', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path.startsWith('/g/history'))
                return {
                    messages: [1, 2].map(seq => ({
                        id: String(seq),
                        seq,
                        sender: { kind: 'session', sessionId: 'worker' },
                        text: `Agent update ${seq}`,
                        mentions: [],
                        receipts: [],
                        createdAt: 1
                    })),
                    hasMore: false
                }
            return original(path, body)
        })
        mount(<GroupChat groupId="g" />)
        expect(await screen.findByText('Agent update 1')).toBeTruthy()
        expect(await screen.findByText('Agent update 2')).toBeTruthy()
        const input = screen.getByRole('textbox', { name: 'Message' })
        fireEvent.change(input, { target: { value: '@Work' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(screen.getByRole('button', { name: 'Remove mention Worker' })).toBeTruthy()
        fireEvent.change(input, { target: { value: 'Composing' } })
        fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
        expect(mocks.request.mock.calls.some(([path]) => path === '/g/send')).toBe(false)
        client.clear()
    })

    it('prepends older history without replacing recent messages', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path.startsWith('/g/history')) {
                const old = path.includes('before=2')
                return {
                    messages: [
                        {
                            id: old ? 'old' : 'recent',
                            seq: old ? 1 : 2,
                            sender: { kind: 'user' },
                            text: old ? 'Earlier discussion' : 'Latest result',
                            mentions: [],
                            createdAt: 1,
                            receipts: []
                        }
                    ],
                    hasMore: !old
                }
            }
            return original(path, body)
        })
        mount(<GroupChat groupId="g" />)
        expect(await screen.findByText('Latest result')).toBeTruthy()
        expect(screen.getByRole('link', { name: 'Back to groups' })).toHaveAttribute('href', '/groups')
        fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))
        expect(await screen.findByText('Earlier discussion')).toBeTruthy()
        expect(screen.getByText('Latest result')).toBeTruthy()
        client.clear()
    })

    it('keeps the draft and idempotency key after a failed send; replies do not mention automatically', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        let sends = 0
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path === '/g/send' && ++sends === 1) throw new Error('Connection interrupted')
            return original(path, body)
        })
        mount(<GroupChat groupId="g" />)
        fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))
        const input = screen.getByRole('textbox', { name: 'Message' })
        fireEvent.change(input, { target: { value: 'Review complete.' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        expect(await screen.findByText('Connection interrupted')).toBeTruthy()
        expect(input).toHaveValue('Review complete.')
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(input).toHaveValue(''))
        const payloads = mocks.request.mock.calls.filter(([path]) => path === '/g/send').map(([, body]) => body)
        expect(payloads).toHaveLength(2)
        expect(payloads[0]).toEqual(payloads[1])
        expect(payloads[0]).toMatchObject({ mentions: [], replyTo: 'm' })
        client.clear()
    })
})
