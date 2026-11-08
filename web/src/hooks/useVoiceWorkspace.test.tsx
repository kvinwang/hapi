import { executeFrontendCommand } from '@/lib/frontendCommands'
import { OPEN_VOICE_PANEL } from './useVoicePanelSettings'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useVoiceWorkspace } from './useVoiceWorkspace'
const mocks = vi.hoisted(() => ({ language: vi.fn(), enabled: vi.fn(), interrupt: vi.fn(), replay: vi.fn(async () => {}), reset: vi.fn(), voiceOptions: null as null | { onSpeechStart: () => void }, voice: { draft: 'Main draft', alternatives: ['Candidate one', 'Candidate two'], deferred: [{ text: 'Pending' }], sending: false, drafting: false, draftIssue: null, micOn: true, clearDraft: vi.fn(), sendDraft: vi.fn(async () => {}), beginDraftEdit: vi.fn(), endDraftEdit: vi.fn(), editDraft: vi.fn(), resolveSpeech: vi.fn(), toggle: vi.fn() } }))
vi.mock('./useOmniVoice', () => ({ useOmniVoice: (options: { onSpeechStart: () => void }) => { mocks.voiceOptions = options; return { ...mocks.voice, resetHistory: mocks.reset } } }))
vi.mock('./useAiReadback', () => ({ useAiReadback: () => ({ enabled: false, language: 'zh', setLanguage: mocks.language, setEnabled: mocks.enabled, interrupt: mocks.interrupt, replayLatest: mocks.replay }) }))
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })
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

it('supplies the active catalog only when navigation is requested', () => {
    const navigate = vi.fn()
    const child = { ...session('child', 1), parentSessionId: 'parent', metadata: { path: '/work', name: 'Fix Microphone Recovery' } }
    const closed = { ...session('closed', 99), active: false, metadata: { path: '/work', name: 'Microphone' } }
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [child, closed, ...Array.from({ length: 8 }, (_, i) => session(`other${i}`, i + 5))], navigate }))
    expect(mocks.voiceOptions).not.toHaveProperty('uiContext')
    const output = result.current.control({ action: 'list_sessions', query: 'microphone recovery' }) as { sessions: Array<{ id: string; title: string }> }
    const catalog = output.sessions
    act(() => { result.current.control({ action: 'switch_session', sessionId: 'child' }) })
    expect(catalog).toHaveLength(9)
    expect(catalog.find((s: { id: string }) => s.id === 'child')).toMatchObject({ title: 'Fix Microphone Recovery' })
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
    expect(result.current.control({ action: 'list_sessions', query: 'microphone recovery' })).toMatchObject({ sessions: [{ recentActivity: 'Investigating microphone recovery' }] })
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

it('applies spoken language changes to the same readback preference as the UI', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions: [], navigate: vi.fn() }))
    act(() => { result.current.control({ action: 'readback_language', language: 'en' }) })
    expect(mocks.language).toHaveBeenCalledExactlyOnceWith('en')
})

it('lets the toolbar open an empty panel and does not reopen on speech in manual mode', () => {
    localStorage.setItem('hapi.voicePanelMode', 'manual')
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'a', terminal: false, sessions: [], navigate: vi.fn() }))
    act(() => { result.current.setPanel('closed'); mocks.voiceOptions?.onSpeechStart() })
    expect(result.current.panel).toBe('closed')
    act(() => window.dispatchEvent(new Event(OPEN_VOICE_PANEL)))
    expect(result.current.panel).toBe('open')
    act(() => mocks.voiceOptions?.onSpeechStart())
    expect(result.current.panel).toBe('open')
})


it('routes frontend settings commands through the same persisted settings as the panel', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'a', terminal: false, sessions: [], navigate: vi.fn() }))
    for (const command of ['draft language en', 'draft alternatives off', 'draft mode manual', 'draft auto-send on 8']) {
        act(() => { executeFrontendCommand({ command }, control => result.current.control(control)) })
    }
    expect(localStorage.getItem('hapi.voiceDraftLanguage')).toBe('en')
    expect(localStorage.getItem('hapi.voiceDraftAlternatives')).toBe('false')
    expect(localStorage.getItem('hapi.voicePanelMode')).toBe('manual')
    expect(JSON.parse(localStorage.getItem('hapi.voiceAutoSend')!)).toEqual({ enabled: true, delay: 8 })
    expect(mocks.language).not.toHaveBeenCalled()
})


it('covers draft selection, pending fragments, delivery requests, clearing, and microphone controls', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'a', terminal: false, sessions: [], navigate: vi.fn() }))
    const run = (command: string) => { let output: unknown; act(() => { output = executeFrontendCommand({ command }, control => result.current.control(control)) }); return output }
    run('draft choose 2')
    expect(mocks.voice.editDraft).toHaveBeenCalledWith('Candidate two')
    expect(mocks.voice.sendDraft).not.toHaveBeenCalled()
    run('draft pending dismiss 1')
    expect(mocks.voice.resolveSpeech).toHaveBeenCalledWith(0, false)
    expect(run('draft choose 4')).toHaveProperty('error')
    expect(run('draft pending include 2')).toHaveProperty('error')
    expect(run('draft send')).toEqual({ requested: 'send', delivered: false })
    expect(mocks.voice.sendDraft).toHaveBeenCalledOnce()
    run('draft clear')
    expect(mocks.voice.clearDraft).toHaveBeenCalledOnce()
    run('mic enabled on')
    expect(mocks.voice.toggle).not.toHaveBeenCalled()
    run('mic enabled off')
    expect(mocks.voice.toggle).toHaveBeenCalledOnce()
})

it('inspects UI state without modifying settings or disclosing draft content', () => {
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'a', terminal: false, sessions: [], navigate: vi.fn() }))
    const status = executeFrontendCommand({ command: 'ui status' }, control => result.current.control(control))
    expect(status).toMatchObject({ sessionId: 'a', draft: { hasText: true, alternatives: 2, pending: 1, language: 'original' }, mic: { enabled: true } })
    expect(JSON.stringify(status)).not.toContain('Main draft')
    expect(localStorage.getItem('hapi.voiceDraftLanguage')).toBeNull()
    expect(mocks.voice.toggle).not.toHaveBeenCalled()
})

it('numbers all available sessions rather than truncating the native panel to five', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(`session-${index + 1}`, index + 1))
    const navigate = vi.fn()
    const { result } = renderHook(() => useVoiceWorkspace({ api: {} as ApiClient, baseUrl: '', token: '', sessionId: 'current', terminal: false, sessions, navigate }))
    act(() => { result.current.control({ action: 'list_sessions' }) })
    expect(result.current.choices).toHaveLength(8)
    act(() => { result.current.control({ action: 'select_session', index: 8 }) })
    expect(navigate).toHaveBeenCalledWith('session-1')
})
