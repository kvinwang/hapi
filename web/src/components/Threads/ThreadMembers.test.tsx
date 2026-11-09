import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ThreadMembers } from './ThreadMembers'

const mocks = vi.hoisted(() => ({ request: vi.fn(), sessions: [] as SessionSummary[] }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { threadRequest: mocks.request } }) }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: mocks.sessions, isLoading: false, error: null }) }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('lists all active nonmembers using voice-picker titles, activity and directory', async () => {
    const session = (id: string, active: boolean, metadata: SessionSummary['metadata']): SessionSummary => ({ id, active, metadata, thinking: false, activeAt: 1, updatedAt: 1, todoProgress: null, pendingRequestsCount: 0 })
    mocks.sessions = [
        session('uuid-summary', true, { path: '/repo/api', summary: { text: 'Review authentication' } }),
        session('uuid-path', true, { name: '', path: '/repo/ui' }),
        session('closed', false, { name: 'Closed session', path: '/repo/old' }),
        ...Array.from({ length: 7 }, (_, i) => session(`worker-${i}`, true, { name: `Worker ${i}`, path: '/repo/workers' }))
    ]
    mocks.sessions[0].activity = { text: 'Checking expiry handling', source: 'summary', seq: 1 }
    mocks.request.mockResolvedValue({ ok: true })
    render(<I18nProvider><ThreadMembers thread={{ id: 't', name: 'Test', description: '', tags: [], archived: false, createdAt: 1 }} members={[]} open onOpenChange={() => {}} error="" mutate={async action => { await action(); return true }} /></I18nProvider>)
    expect(screen.getByText('Review authentication')).toBeTruthy()
    expect(screen.getByText('/repo/ui')).toBeTruthy()
    expect(screen.getByText(/Checking expiry handling/)).toBeTruthy()
    expect(screen.getByText(/\/repo\/api/)).toBeTruthy()
    expect(screen.queryByText('uuid-summary')).toBeNull()
    expect(screen.queryByText('Closed session')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Add$/ })).toHaveLength(9)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions' }), { target: { value: 'authentication' } })
    expect(screen.getAllByRole('button', { name: /Add$/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /Review authentication.*Add$/ }))
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('/t/add', { sessionId: 'uuid-summary' }))
})
