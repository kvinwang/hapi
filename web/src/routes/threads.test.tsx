import { I18nProvider } from '@/lib/i18n-context'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ThreadsPage from './threads'
import { ThreadChat } from '@/components/Threads/ThreadChat'

const mocks = vi.hoisted(() => ({ request: vi.fn(), navigate: vi.fn(), preferences: vi.fn(), updatePreferences: vi.fn() }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { threadRequest: mocks.request, getPreferences: mocks.preferences, updatePreferences: mocks.updatePreferences } }) }))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copied: false, copy: async () => true }) }))
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
    localStorage.removeItem('hapi-threads-hide-archived')
    vi.clearAllMocks()
})
const thread = {
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
    mocks.preferences.mockResolvedValue({ quickPhrases: [{ text: 'Please continue.', action: 'send' }, { text: 'Check the tests', action: 'insert' }] })
    let readAt: number | null = null
    mocks.request.mockImplementation(async (path: string, body?: unknown) => {
        if (path === '') return { threads: [thread] }
        if (path === '/g') return { thread, members }
        if (path.startsWith('/g/history'))
            return {
                messages: [
                    {
                        id: 'm',
                        threadId: 'g',
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
        mount: (children: ReactNode) => render(<QueryClientProvider client={client}><I18nProvider>{children}</I18nProvider></QueryClientProvider>)
    }
}

describe('Thread conversations', () => {
    it('creates and revokes sharing from the header using the shared link controls', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        let token: string | null = null
        mocks.request.mockImplementation(async (path: string, body?: { enabled: boolean }) => {
            if (path === '/g/share') {
                if (body) token = body.enabled ? 'public-link' : null
                return { shareToken: token }
            }
            return original(path, body)
        })
        mount(<ThreadChat threadId="g" />)
        const share = await screen.findByRole('button', { name: 'Share' })
        await waitFor(() => expect(share).toBeEnabled())
        fireEvent.click(share)
        const toggle = await screen.findByRole('switch', { name: 'Shared' })
        await waitFor(() => expect(toggle).toBeEnabled())
        expect(toggle).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(toggle)
        expect(await screen.findByRole('textbox', { name: 'Copy link' })).toHaveValue(`${window.location.origin}/shared/threads/public-link`)
        fireEvent.click(toggle)
        await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Copy link' })).toBeNull())
        expect(mocks.request).toHaveBeenCalledWith('/g/share', { enabled: false })
        client.clear()
    })

    it('stars only human text messages and shares saved phrases with the reply panel', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path.startsWith('/g/history')) return { messages: [
                { id: 'human', seq: 1, sender: { kind: 'user' }, text: 'Review carefully', mentions: [], receipts: [], createdAt: 1 },
                { id: 'agent', seq: 2, sender: { kind: 'session', sessionId: 'worker' }, text: 'Agent reply', mentions: [], receipts: [], createdAt: 2 },
                { id: 'mention', seq: 3, sender: { kind: 'user' }, text: '', mentions: ['worker'], receipts: [], createdAt: 3 }
            ], hasMore: false }
            return original(path, body)
        })
        mocks.updatePreferences.mockImplementation(async (patch: unknown) => patch)
        mount(<ThreadChat threadId="g" />)
        const star = await screen.findByRole('button', { name: 'Save as quick phrase' })
        await waitFor(() => expect(star).toBeEnabled())
        expect(screen.getAllByRole('button', { name: 'Save as quick phrase' })).toHaveLength(1)
        fireEvent.click(star)
        await waitFor(() => expect(mocks.updatePreferences).toHaveBeenCalledWith({ quickPhrases: expect.arrayContaining([{ text: 'Review carefully', action: 'send' }]) }))
        expect(await screen.findByRole('button', { name: 'Remove from quick phrases' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Quick phrases' }))
        expect(await screen.findByRole('button', { name: 'Review carefully' })).toBeTruthy()
        fireEvent.keyDown(document, { key: 'Escape' })
        fireEvent.click(screen.getByRole('button', { name: 'Remove from quick phrases' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save as quick phrase' })).toHaveAttribute('aria-pressed', 'false'))
        expect(mocks.updatePreferences.mock.calls.at(-1)?.[0].quickPhrases.some((phrase: { text: string }) => phrase.text === 'Review carefully')).toBe(false)
        client.clear()
    })

    it('searches thread names, descriptions and IDs while respecting the archive filter', async () => {
        const { client, mount } = setup()
        mocks.request.mockResolvedValue({ threads: [
            { ...thread, name: 'API Review', description: 'Authentication work' },
            { ...thread, id: 'docs', name: 'Documentation', description: 'Release notes' },
            { ...thread, id: 'old', name: 'Old review', description: 'Authentication work', archived: true }
        ] })
        mount(<ThreadsPage />)
        await screen.findByRole('link', { name: /API Review/ })
        const input = screen.getByRole('searchbox', { name: 'Search threads…' })
        fireEvent.change(input, { target: { value: '  AUTHENTICATION  ' } })
        expect(screen.getByRole('link', { name: /API Review/ })).toBeTruthy()
        expect(screen.queryByRole('link', { name: /Documentation/ })).toBeNull()
        expect(screen.queryByRole('link', { name: /Old review/ })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
        expect(screen.getByRole('link', { name: /Old review/ })).toBeTruthy()
        fireEvent.change(input, { target: { value: 'docs' } })
        expect(screen.getByRole('link', { name: /Documentation/ })).toBeTruthy()
        fireEvent.change(input, { target: { value: 'missing' } })
        expect(screen.getByText('No matching threads')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
        expect(input).toHaveValue('')
        expect(screen.getByRole('link', { name: /API Review/ })).toBeTruthy()
        client.clear()
    })

    it('inserts a saved reply at the selection without sending and closes on Escape', async () => {
        const { client, mount } = setup()
        mount(<ThreadChat threadId="g" />)
        const input = await screen.findByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
        fireEvent.change(input, { target: { value: 'Please replace this.' } })
        input.setSelectionRange(7, 19)
        fireEvent.click(screen.getByRole('button', { name: 'Quick phrases' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Check the tests' }))
        expect(input).toHaveValue('Please Check the tests.')
        expect(mocks.request.mock.calls.some(([path]) => path === '/g/send')).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Quick phrases' }))
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('region', { name: 'Quick phrases' })).toBeNull()
        client.clear()
    })

    it('sends a quick reply with the selected mention and reply target while keeping the draft', async () => {
        const { client, mount } = setup()
        mount(<ThreadChat threadId="g" />)
        fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))
        const input = screen.getByRole('textbox', { name: 'Message' })
        fireEvent.change(input, { target: { value: '@Work' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        fireEvent.change(input, { target: { value: 'Unfinished draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'Quick phrases' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Please continue.' }))
        await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/g/send', expect.objectContaining({ text: 'Please continue.', mentions: ['worker'], replyTo: 'm' })))
        expect(input).toHaveValue('Unfinished draft')
        client.clear()
    })

    it('hides archived threads by default and remembers the list toggle', async () => {
        const { client, mount } = setup()
        mocks.request.mockResolvedValue({ threads: [thread, { ...thread, id: 'archived', name: 'Archived discussion', archived: true }] })
        mount(<ThreadsPage />)
        await screen.findByRole('link', { name: /Review/ })
        expect(screen.queryByRole('link', { name: /Archived discussion/ })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
        expect(screen.getByRole('link', { name: /Archived discussion/ })).toBeTruthy()
        expect(localStorage.getItem('hapi-threads-hide-archived')).toBe('false')
        fireEvent.click(screen.getByRole('button', { name: 'Hide archived' }))
        expect(screen.queryByRole('link', { name: /Archived discussion/ })).toBeNull()
        client.clear()
    })

    it('archives directly from the conversation header and disables the composer', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        let archived = false
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path === '/g/archive') { archived = true; return { ok: true } }
            if (path === '/g/restore') { archived = false; return { ok: true } }
            if (path === '/g') return { thread: { ...thread, archived }, members }
            return original(path, body)
        })
        mount(<ThreadChat threadId="g" />)
        fireEvent.click(await screen.findByRole('button', { name: 'Archive thread' }))
        await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/g/archive', {}))
        expect(await screen.findByText('This thread is archived. Its conversation remains available.')).toBeTruthy()
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Restore thread' }).closest('header')).not.toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Restore thread' }))
        expect(await screen.findByRole('textbox', { name: 'Message' })).toBeTruthy()
        expect(mocks.request).toHaveBeenCalledWith('/g/restore', {})
        expect(screen.getByRole('button', { name: 'Archive thread' }).closest('header')).not.toBeNull()
        client.clear()
    })

    it('sends a selected mention without text but disables empty broadcasts', async () => {
        const { client, mount } = setup()
        mount(<ThreadChat threadId="g" />)
        const input = await screen.findByRole('textbox', { name: 'Message' })
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
        fireEvent.change(input, { target: { value: '@Work' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(input).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/g/send', expect.objectContaining({ text: '', mentions: ['worker'] })))
        client.clear()
    })

    it('links threads to dedicated conversations without putting creation in the chat', async () => {
        const { client, mount } = setup()
        mount(<ThreadsPage />)
        expect(await screen.findByRole('link', { name: /Review/ })).toHaveAttribute('href', '/threads/g')
        expect(screen.getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/sessions')
        expect(screen.getByRole('link', { name: 'Threads' })).toHaveAttribute('aria-current', 'page')
        expect(screen.queryByRole('textbox', { name: 'Thread name' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /New thread/ }))
        expect(await screen.findByRole('textbox', { name: 'Thread name' })).toBeTruthy()
        client.clear()
    })

    it('renders markdown, confirms only the human reader, and sends explicit @mentions', async () => {
        const { client, mount } = setup()
        mount(<ThreadChat threadId="g" fromSession="source-session" />)
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
        expect(screen.getByRole('button', { name: 'Archive thread' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Members & settings' }))
        expect(await screen.findByRole('button', { name: 'Archive thread' })).toBeTruthy()
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
        mount(<ThreadChat threadId="g" />)
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
        mount(<ThreadChat threadId="g" />)
        expect(await screen.findByText('Latest result')).toBeTruthy()
        expect(screen.getByRole('link', { name: 'Back to threads' })).toHaveAttribute('href', '/threads')
        fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))
        expect(await screen.findByText('Earlier discussion')).toBeTruthy()
        expect(screen.getByText('Latest result')).toBeTruthy()
        client.clear()
    })

    it('keeps the draft and idempotency key after a failed send; reply notifications are shown and resolved by the server', async () => {
        const { client, mount } = setup()
        const original = mocks.request.getMockImplementation()!
        let sends = 0
        mocks.request.mockImplementation(async (path: string, body?: unknown) => {
            if (path === '/g/send' && ++sends === 1) throw new Error('Connection interrupted')
            return original(path, body)
        })
        mount(<ThreadChat threadId="g" />)
        fireEvent.click(await screen.findByRole('button', { name: 'Reply' }))
        expect(screen.getByText('Notifies @Worker')).toBeTruthy()
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
