import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useVoiceWorkspace } from './useVoiceWorkspace'
const mocks = vi.hoisted(() => ({ enabled: vi.fn() }))
vi.mock('./useOmniVoice', () => ({ useOmniVoice: () => ({}) }))
vi.mock('./useAiReadback', () => ({ useAiReadback: () => ({ enabled: false, setEnabled: mocks.enabled }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function session(id: string, updatedAt: number): SessionSummary {
    return { id, updatedAt, activeAt: updatedAt, active: true, thinking: false, metadata: { path: '/', name: id }, todoProgress: null, pendingRequestsCount: 0 }
}
it('freezes recent-session numbering until selection and requires an open list', () => {
    const navigate = vi.fn()
    const options = { api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, navigate }
    const { result, rerender } = renderHook(({ sessions }) => useVoiceWorkspace({ ...options, sessions }), { initialProps: { sessions: [session('a', 1), session('b', 2), session('current', 3)] } })
    act(() => { result.current.control({ action: 'select_session', index: 1 }) })
    expect(navigate).not.toHaveBeenCalled()
    act(() => { result.current.control({ action: 'list_sessions' }) })
    expect(result.current.choices?.map(s => s.id)).toEqual(['b', 'a'])
    rerender({ sessions: [session('a', 4), session('b', 2)] })
    act(() => { result.current.control({ action: 'select_session', index: 2 }) })
    expect(navigate).toHaveBeenCalledExactlyOnceWith('a')
    expect(result.current.choices).toBeNull()
})
it('sets readback and draft visibility explicitly rather than toggling', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'a', terminal: false, sessions: [], navigate: vi.fn() }))
    act(() => { result.current.control({ action: 'readback', enabled: true }); result.current.control({ action: 'draft_panel', open: false }) })
    expect(mocks.enabled).toHaveBeenCalledWith(true)
    expect(result.current.panel).toBe('closed')
    act(() => { result.current.control({ action: 'draft_panel', open: true }) })
    expect(result.current.panel).toBe('open')
})
