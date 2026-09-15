import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toSessionSummary } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import { SessionHeader } from './SessionHeader'
import { SessionList } from './SessionList'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/components/SessionPropertiesDialog', () => ({ SessionPropertiesDialog: () => null }))
vi.mock('@/components/SwitchAgentDialog', () => ({ SwitchAgentDialog: () => null }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: vi.fn() } }) }))

beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
        value: { getItem: vi.fn(() => 'en'), setItem: vi.fn() }, configurable: true
    })
})
afterEach(cleanup)

function setup(entry: 'header' | 'list') {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
    const session: Session = {
        id: 'parent', namespace: 'default', createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        seq: 0, metadataVersion: 1, agentStateVersion: 1, metadata: { name: 'Parent', path: '/repo', host: 'host' },
        agentState: null, thinking: false, thinkingAt: 1
    }
    const child: Session = { ...session, id: 'child', parentSessionId: session.id, metadata: { ...session.metadata!, name: 'Child' } }
    const sessions = [session, child].map(toSessionSummary)
    client.setQueryData(queryKeys.sessions, { sessions })
    client.setQueryData(queryKeys.sessionUiState(session.id), {})
    const archive = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
    const api = {
        archiveSession: archive,
        getSessions: async () => ({ sessions }),
        getSessionUiState: async () => ({}),
        getSessionShareStatus: async () => ({ shareToken: null })
    } as unknown as ApiClient
    render(
        <QueryClientProvider client={client}>
            <I18nProvider>
                {entry === 'header' ? <SessionHeader session={session} api={api} onBack={vi.fn()} /> : (
                    <SessionList sessions={sessions} api={api} viewMode="flat" onSelect={vi.fn()} onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} />
                )}
            </I18nProvider>
        </QueryClientProvider>
    )
    const open = () => {
        if (entry === 'header') fireEvent.click(screen.getByTitle('More actions'))
        else fireEvent.contextMenu(screen.getByText('Parent').closest('button')!)
    }
    return { archive, open }
}

for (const entry of ['header', 'list'] as const) {
    describe(`${entry} archive action`, () => {
        it('archives directly without a confirmation, even with descendants', async () => {
            const { archive, open } = setup(entry)
            open()
            fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
            await waitFor(() => expect(archive).toHaveBeenCalledExactlyOnceWith('parent'))
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
            expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
            expect(screen.queryByRole('menu')).not.toBeInTheDocument()
        })

        it('displays archive failures inline', async () => {
            const { archive, open } = setup(entry)
            archive.mockRejectedValueOnce(new Error('Archive failed'))
            open()
            fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
            expect(await screen.findByText('Archive failed')).toBeInTheDocument()
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        })

        it('disables repeated archive requests while pending', async () => {
            const { archive, open } = setup(entry)
            let finish = () => {}
            archive.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
            open()
            fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
            await waitFor(() => expect(archive).toHaveBeenCalledOnce())
            open()
            const button = screen.getByRole('menuitem', { name: 'Archive' })
            await waitFor(() => expect(button).toBeDisabled())
            fireEvent.click(button)
            expect(archive).toHaveBeenCalledOnce()
            await act(async () => finish())
        })
    })
}
