import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { GoalPanel, buildReminderObjective } from './GoalPanel'

function makeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
    return {
        getSessionUiState: vi.fn().mockResolvedValue({
            lastGoal: { objective: 'ship the release', tokenBudget: 5000, usedAt: 2 }
        }),
        setGoal: vi.fn().mockResolvedValue({ goal: {} }),
        clearGoal: vi.fn().mockResolvedValue(undefined),
        ...overrides
    } as unknown as ApiClient
}

describe('GoalPanel', () => {
    afterEach(() => cleanup())

    it('fills the editor from the last goal of this session', async () => {
        const api = makeApi()
        render(<GoalPanel api={api} sessionId="s1" goal={null} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /Set goal/ }))
        const reuse = await screen.findByRole('button', { name: /ship the release/ })
        fireEvent.click(reuse)

        expect(api.getSessionUiState).toHaveBeenCalledWith('s1')
        expect(screen.getByPlaceholderText('Goal objective')).toHaveValue('ship the release')
        expect(screen.getByPlaceholderText('Token budget')).toHaveValue(5000)
        // Once reused, the shortcut disappears because the editor already holds that objective.
        await waitFor(() => expect(screen.queryByRole('button', { name: /↺/ })).not.toBeInTheDocument())
    })

    it('offers no shortcut when the session has no previous goal', async () => {
        const api = makeApi({ getSessionUiState: vi.fn().mockResolvedValue({}) })
        render(<GoalPanel api={api} sessionId="s1" goal={null} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /Set goal/ }))
        await waitFor(() => expect(api.getSessionUiState).toHaveBeenCalled())

        expect(screen.queryByRole('button', { name: /↺/ })).not.toBeInTheDocument()
    })

    it('pauses an active goal without touching the objective', async () => {
        const api = makeApi()
        const goal = { objective: 'ship the release', status: 'active' as const, tokenBudget: null, tokensUsed: null, timeUsedSeconds: 0 }
        render(<GoalPanel api={api} sessionId="s1" goal={goal} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /ship the release/ }))
        fireEvent.click(screen.getByRole('button', { name: /Pause/ }))

        await waitFor(() => expect(api.setGoal).toHaveBeenCalledWith('s1', { status: 'paused' }))
    })

    it('resumes a paused goal', async () => {
        const api = makeApi()
        const goal = { objective: 'ship the release', status: 'paused' as const, tokenBudget: null, tokensUsed: null, timeUsedSeconds: 0 }
        render(<GoalPanel api={api} sessionId="s1" goal={goal} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /ship the release/ }))
        fireEvent.click(screen.getByRole('button', { name: /Resume/ }))

        await waitFor(() => expect(api.setGoal).toHaveBeenCalledWith('s1', { status: 'active' }))
    })

    it('sets a reminder goal in one click', async () => {
        const api = makeApi()
        render(<GoalPanel api={api} sessionId="s1" goal={null} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /Set goal/ }))
        fireEvent.change(screen.getByRole('spinbutton', { name: 'Reminder duration in hours' }), { target: { value: '3' } })
        fireEvent.click(screen.getByRole('button', { name: /Remind me/ }))

        await waitFor(() => expect(api.setGoal).toHaveBeenCalled())
        const [sessionId, payload] = (api.setGoal as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
        expect(sessionId).toBe('s1')
        expect(payload.status).toBe('active')
        expect(payload.objective).toContain('every 15 minutes')
        expect(payload.objective).toContain('3 hour(s) from now')
    })
})

describe('buildReminderObjective', () => {
    it('describes the interval, the wait and the deadline', () => {
        const now = Date.UTC(2026, 0, 1, 0, 0, 0)
        const objective = buildReminderObjective(20, 4, now)

        expect(objective).toContain('every 20 minutes')
        expect(objective).toContain('wait out the full 20 minutes')
        expect(objective).toContain('2026-01-01T04:00:00.000Z')
        expect(objective).toContain('mark this goal complete')
    })
})
