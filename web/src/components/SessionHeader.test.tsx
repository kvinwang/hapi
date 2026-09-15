import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session, SessionsResponse, SessionUiState } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionsResponse } from '@/lib/session-cache'
import { SessionHeader } from './SessionHeader'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/components/SessionPropertiesDialog', () => ({ SessionPropertiesDialog: () => null }))
vi.mock('@/components/SwitchAgentDialog', () => ({ SwitchAgentDialog: () => null }))
vi.mock('@/components/DeleteSessionDialog', () => ({ DeleteSessionDialog: () => null }))

beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
        value: { getItem: vi.fn(() => 'en'), setItem: vi.fn() }, configurable: true
    })
})
afterEach(cleanup)

function setup(favorite = false) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
    const session: Session = {
        id: 's1', namespace: 'default', createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        seq: 0, metadataVersion: 1, agentStateVersion: 1, metadata: { path: '/repo', host: 'host' },
        agentState: null, thinking: false, thinkingAt: 1
    }
    let state: SessionUiState = { favorite }
    let response: SessionsResponse = { sessions: [{
        id: session.id, active: false, activeAt: 1, updatedAt: 1, thinking: false,
        metadata: { path: '/repo' }, favorite, pendingRequestsCount: 0, todoProgress: null
    }] }
    queryClient.setQueryData(queryKeys.sessions, response)
    queryClient.setQueryData(queryKeys.sessionUiState(session.id), state)
    const update = vi.fn(async (_id: string, patch: SessionUiState) => {
        state = { ...state, ...patch }
        response = { sessions: [{ ...response.sessions[0], favorite: state.favorite }] }
        return state
    })
    const api = {
        getSessions: async () => response,
        getSessionUiState: async () => state,
        updateSessionUiState: update
    } as unknown as ApiClient
    render(<QueryClientProvider client={queryClient}><I18nProvider><SessionHeader session={session} api={api} onBack={vi.fn()} /></I18nProvider></QueryClientProvider>)
    const open = () => fireEvent.click(screen.getByTitle('More actions'))
    return { update, queryClient, open }
}

describe('SessionHeader favorites', () => {
    it('adds and removes favorites from the chat menu and updates shared caches', async () => {
        const { update, queryClient, open } = setup()
        open()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to favorites' }))
        await waitFor(() => expect(queryClient.getQueryData<SessionUiState>(queryKeys.sessionUiState('s1'))?.favorite).toBe(true))
        expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0].favorite).toBe(true)
        open()
        const remove = await screen.findByRole('menuitem', { name: 'Remove from favorites' })
        await waitFor(() => expect(remove).toBeEnabled())
        fireEvent.click(remove)
        await waitFor(() => expect(update).toHaveBeenLastCalledWith('s1', { favorite: false }))
        await waitFor(() => expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0].favorite).toBe(false))
    })

    it('shows live list updates rather than stale UI-state favorites', async () => {
        const { queryClient, open } = setup()
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current =>
            mergeSessionsResponse(current, 's1', { uiState: { favorite: true } })
        )
        open()
        await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Remove from favorites' })).toBeInTheDocument())
    })

    it('shows save errors without changing the favorite state', async () => {
        const { update, queryClient, open } = setup()
        update.mockRejectedValueOnce(new Error('Favorite save failed'))
        open()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to favorites' }))
        expect(await screen.findByText('Favorite save failed')).toBeInTheDocument()
        expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0].favorite).toBe(false)
    })
})
