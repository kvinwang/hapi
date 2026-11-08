import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import { BackgroundTasks } from './BackgroundTasks'

const tasks = { bg1: { id: 'bg1', description: 'Benchmark', command: 'sleep 60', status: 'running' as const, startedAt: Date.now() } }

function setup(active: boolean) {
    const api = { getTaskOutput: vi.fn().mockResolvedValue({ output: 'Progress: 10%' }), stopTask: vi.fn().mockResolvedValue({ ok: true }) }
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider>
        <BackgroundTasks tasks={tasks} sessionId="session" host="box" active={active} api={api as unknown as ApiClient} />
    </I18nProvider></QueryClientProvider>)
    return api
}

describe('BackgroundTasks', () => {
    it('shows background tasks independently of agent thinking and reads selected output', async () => {
        const api = setup(true)
        fireEvent.click(screen.getByRole('button', { name: /Tasks 1/ }))
        fireEvent.click(screen.getByRole('button', { name: /Benchmark/ }))
        expect(await screen.findByText('Progress: 10%')).toBeInTheDocument()
        expect(api.getTaskOutput).toHaveBeenCalledWith('session', 'bg1')
        vi.spyOn(window, 'confirm').mockReturnValue(true)
        fireEvent.click(screen.getByRole('button', { name: 'Stop task' }))
        await waitFor(() => expect(api.stopTask).toHaveBeenCalledWith('session', 'bg1'))
        vi.restoreAllMocks()
    })

    it('does not claim inactive sessions still have running tasks', () => {
        const api = setup(false)
        fireEvent.click(screen.getByRole('button', { name: 'Tasks 1' }))
        fireEvent.click(screen.getByRole('button', { name: /Benchmark/ }))
        expect(screen.getByText(/Unknown/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Stop task' })).not.toBeInTheDocument()
        expect(api.getTaskOutput).not.toHaveBeenCalled()
    })
})
