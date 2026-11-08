import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { VoiceSessionList } from './VoiceSessionList'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string, args?: { number?: number }) => args?.number ? `Session ${args.number}` : key }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: vi.fn() }, isTouch: false }) }))
vi.mock('@/components/SessionMenu', () => ({ SessionMenu: () => null }))
vi.mock('@/components/SessionPropertiesDialog', () => ({ SessionPropertiesDialog: () => null }))
vi.mock('@/components/DeleteSessionDialog', () => ({ DeleteSessionDialog: () => null }))
afterEach(() => { cleanup(); localStorage.clear() })

it('reuses native session cards with frozen numbered ordering and visible child sessions', () => {
    const sessions: SessionSummary[] = [
        { id: 'first', updatedAt: 1, activeAt: 1, active: true, thinking: false, metadata: { name: 'First session', path: '/first' }, todoProgress: null, pendingRequestsCount: 0 },
        { id: 'second', parentSessionId: 'first', pinned: true, updatedAt: 100, activeAt: 100, active: true, thinking: false, metadata: { name: 'Child session', path: '/second' }, todoProgress: null, pendingRequestsCount: 0 },
    ]
    const onSelect = vi.fn(), onCancel = vi.fn()
    const { container } = render(<QueryClientProvider client={new QueryClient()}><VoiceSessionList api={{} as ApiClient}
        sessions={sessions} search="" onSelect={onSelect} onCancel={onCancel} /></QueryClientProvider>)
    expect(container.querySelectorAll('.session-list-item')).toHaveLength(2)
    expect(Array.from(container.querySelectorAll('[data-session-number]'), badge => badge.textContent?.trim())).toEqual(['1', '2'])
    fireEvent.mouseDown(screen.getByRole('button', { name: /Child session/ }), { button: 0 })
    fireEvent.mouseUp(screen.getByRole('button', { name: /Child session/ }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2)
    fireEvent.click(screen.getByRole('button', { name: 'voice.ui.cancelSelection' }))
    expect(onCancel).toHaveBeenCalledOnce()
})
