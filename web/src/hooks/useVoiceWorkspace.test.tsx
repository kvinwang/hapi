import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useVoiceWorkspace } from './useVoiceWorkspace'
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), interrupt: vi.fn(), replay: vi.fn(async () => {}), reset: vi.fn(), voiceOptions: null as null | { onSpeechStart: () => void; uiContext: string } }))
vi.mock('./useOmniVoice', () => ({ useOmniVoice: (options: { onSpeechStart: () => void; uiContext: string }) => { mocks.voiceOptions = options; return { resetHistory: mocks.reset } } }))
vi.mock('./useAiReadback', () => ({ useAiReadback: () => ({ enabled: false, setEnabled: mocks.enabled, interrupt: mocks.interrupt, replayLatest: mocks.replay }) }))
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
    expect(result.current.panel).toBe('auto')
})

it('includes recent child sessions and returns their working directories', () => {
    const child = { ...session('child', 10), parentSessionId: 'parent', metadata: { name: 'Child', path: '/work/child' } }
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [session('parent', 1), child], navigate: vi.fn() }))
    let output: unknown
    act(() => { output = result.current.control({ action: 'list_sessions' }) })
    expect(result.current.choices?.map(s => s.id)).toEqual(['child', 'parent'])
    expect(output).toMatchObject({ choices: [{ index: 1, directory: '/work/child', child: true }, { index: 2 }] })
})

it('persists auto-send changes and preserves enabled state for delay-only requests', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'a', terminal: false, sessions: [], navigate: vi.fn() }))
    act(() => { result.current.control({ action: 'auto_send', enabled: true, delay: 12 }) })
    expect(JSON.parse(localStorage.getItem('hapi.voiceAutoSend')!)).toEqual({ enabled: true, delay: 12 })
    act(() => { result.current.control({ action: 'auto_send', enabled: false }) })
    act(() => { result.current.control({ action: 'auto_send', delay: 7 }) })
    expect(JSON.parse(localStorage.getItem('hapi.voiceAutoSend')!)).toEqual({ enabled: false, delay: 7 })
    localStorage.removeItem('hapi.voiceAutoSend')
})


it('excludes closed sessions and rejects an entry that closes after the list opens', () => {
    const navigate = vi.fn()
    const active = session('active', 1)
    const closed = { ...session('closed', 10), active: false }
    const options = { api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, navigate }
    const { result, rerender } = renderHook(({ sessions }) => useVoiceWorkspace({ ...options, sessions }), { initialProps: { sessions: [closed, active] } })
    act(() => { result.current.control({ action: 'list_sessions' }) })
    expect(result.current.choices?.map(s => s.id)).toEqual(['active'])
    rerender({ sessions: [closed, { ...active, active: false }] })
    act(() => { result.current.control({ action: 'select_session', index: 1 }) })
    expect(navigate).not.toHaveBeenCalled()
})


it('restores automatic draft visibility on fresh speech and clears choices on voice reset', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [session('a', 1)], navigate: vi.fn() }))
    act(() => { result.current.control({ action: 'draft_panel', open: false }) })
    expect(result.current.panel).toBe('closed')
    act(() => mocks.voiceOptions?.onSpeechStart())
    expect(result.current.panel).toBe('auto')
    act(() => { result.current.control({ action: 'list_sessions' }) })
    act(() => { result.current.control({ action: 'reset_voice' }) })
    expect(mocks.reset).toHaveBeenCalledOnce()
    expect(result.current.choices).toBeNull()
    expect(result.current.panel).toBe('auto')
})

it('supplies the full active catalog and switches directly to the model-selected child', () => {
    const navigate = vi.fn()
    const child = { ...session('child', 1), parentSessionId: 'parent', metadata: { path: '/work', name: 'Fix Microphone Recovery' } }
    const closed = { ...session('closed', 99), active: false, metadata: { path: '/work', name: 'Microphone' } }
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [child, closed, ...Array.from({ length: 8 }, (_, i) => session(`other${i}`, i + 5))], navigate }))
    act(() => { result.current.control({ action: 'switch_session', sessionId: 'child' }) })
    const catalog = JSON.parse(mocks.voiceOptions!.uiContext).availableSessions
    expect(catalog).toHaveLength(9)
    expect(catalog.find((s: { id: string }) => s.id === 'child')).toMatchObject({ title: 'Fix Microphone Recovery', directory: '/work', parentSessionId: 'parent' })
    expect(catalog.some((s: { id: string }) => s.id === 'closed')).toBe(false)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('child')
    expect(result.current.choices).toBeNull()
})

it('shows ambiguous matches, keeps their numbering, and leaves the current session on no match', () => {
    const navigate = vi.fn()
    const sessions = ['Audio input', 'Audio output'].map((name, i) => ({ ...session(name, i), metadata: { path: '/work', name } }))
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions, navigate }))
    act(() => { result.current.control({ action: 'suggest_sessions', sessionIds: ['Audio output', 'Audio input'], query: 'audio' }) })
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.choices?.map(s => s.id)).toEqual(['Audio output', 'Audio input'])
    act(() => { result.current.control({ action: 'select_session', index: 2 }) })
    expect(navigate).toHaveBeenCalledExactlyOnceWith('Audio input')
    act(() => { result.current.control({ action: 'suggest_sessions', sessionIds: ['invalid'], query: 'Missing' }) })
    expect(result.current.choices).toEqual([])
    expect(result.current.search).toBe('Missing')
    expect(navigate).toHaveBeenCalledOnce()
})


it('provides activity summaries and rejects invented or closed model targets', () => {
    const navigate = vi.fn()
    const current = { ...session('a', 1), activity: { text: 'Investigating microphone recovery', source: 'summary' as const, seq: 3 } }
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [current, { ...session('closed', 2), active: false }], navigate }))
    expect(JSON.parse(mocks.voiceOptions!.uiContext).availableSessions[0].recentActivity).toBe('Investigating microphone recovery')
    act(() => { result.current.control({ action: 'switch_session', sessionId: 'invented' }); result.current.control({ action: 'switch_session', sessionId: 'closed' }) })
    expect(navigate).not.toHaveBeenCalled()
})


it('passes replay focus and forwards the original question only when the reader requests it', async () => {
    const sendMessage = vi.fn(async () => ({}))
    const api = { resumeSession: async () => 'current', sendMessage } as unknown as ApiClient
    const { result } = renderHook(() => useVoiceWorkspace({ api, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [], navigate: vi.fn() }))
    act(() => { result.current.control({ action: 'replay_readback', focus: 'Unresolved issues' }) })
    expect(mocks.replay).toHaveBeenCalledWith('Unresolved issues')
    act(() => { result.current.control({ action: 'answer_readback', question: 'What is the deployment URL?' }) })
    expect(sendMessage).not.toHaveBeenCalled()
    const forward = (mocks.replay.mock.calls.at(-1) as unknown as [undefined, string, () => Promise<void>])[2]
    await act(async () => forward())
    expect(sendMessage).toHaveBeenCalledWith('current', 'What is the deployment URL?', expect.any(String))
    expect(result.current.answerStatus).toBe('forwarded')
})


it('interrupts current readback without changing the automatic readback preference', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [], navigate: vi.fn() }))
    act(() => { result.current.control({ action: 'stop_readback' }) })
    expect(mocks.interrupt).toHaveBeenCalledOnce()
    expect(mocks.enabled).not.toHaveBeenCalled()
})
