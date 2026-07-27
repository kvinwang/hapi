import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { GoalPanel, buildReminderObjective } from './GoalPanel'

function makeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
    return {
        listGoalHistory: vi.fn().mockResolvedValue({
            goals: [
                { objective: 'ship the release', tokenBudget: 5000, useCount: 2, createdAt: 1, usedAt: 2 },
                { objective: 'write the docs', tokenBudget: null, useCount: 1, createdAt: 1, usedAt: 1 }
            ]
        }),
        deleteGoalHistory: vi.fn().mockResolvedValue({ deleted: true }),
        setGoal: vi.fn().mockResolvedValue({ goal: {} }),
        clearGoal: vi.fn().mockResolvedValue(undefined),
        ...overrides
    } as unknown as ApiClient
}

describe('GoalPanel', () => {
    afterEach(() => cleanup())

    it('fills the editor from a remembered goal', async () => {
        const api = makeApi()
        render(<GoalPanel api={api} sessionId="s1" goal={null} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /Set goal/ }))
        const picker = await screen.findByRole('combobox', { name: 'Recent goals' })
        await waitFor(() => expect(screen.getByRole('option', { name: 'ship the release' })).toBeInTheDocument())

        fireEvent.change(picker, { target: { value: 'ship the release' } })

        expect(screen.getByPlaceholderText('Goal objective')).toHaveValue('ship the release')
        expect(screen.getByPlaceholderText('Token budget')).toHaveValue(5000)
    })

    it('forgets a remembered goal', async () => {
        const api = makeApi()
        render(<GoalPanel api={api} sessionId="s1" goal={null} active={true} />)

        fireEvent.click(screen.getByRole('button', { name: /Set goal/ }))
        const picker = await screen.findByRole('combobox', { name: 'Recent goals' })
        await waitFor(() => expect(screen.getByRole('option', { name: 'write the docs' })).toBeInTheDocument())
        fireEvent.change(picker, { target: { value: 'write the docs' } })

        fireEvent.click(screen.getByRole('button', { name: 'Remove from recent goals' }))

        expect(api.deleteGoalHistory).toHaveBeenCalledWith('write the docs')
        await waitFor(() => expect(screen.queryByRole('option', { name: 'write the docs' })).not.toBeInTheDocument())
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
