import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { useAiReadback } from './useAiReadback'

const mock = vi.hoisted(() => ({ listener: null as (() => void) | null, live: null as ((message: DecryptedMessage) => void) | null, players: [] as Array<{ audio?: AudioContext; sessionId: string; getToken?: () => string }>, messages: [] as DecryptedMessage[], liveBySession: new Map<string, (message: DecryptedMessage) => void>(), enqueue: vi.fn(), interrupt: vi.fn(), close: vi.fn(), start: vi.fn(async () => {}) }))
vi.mock('@/lib/message-window-store', () => ({
    getMessageWindowState: () => ({ messages: mock.messages, pending: [], newestSeq: mock.messages.at(-1)?.seq ?? null }),
    subscribeLiveMessages: (id: string, listener: (message: DecryptedMessage) => void) => { mock.live = listener; mock.liveBySession.set(id, listener); return () => { mock.liveBySession.delete(id); mock.live = null } },
    subscribeMessageWindow: (_id: string, listener: () => void) => { mock.listener = listener; return () => { mock.listener = null } }
}))
vi.mock('@/lib/aiReadback', async (original) => ({
    ...await original<typeof import('@/lib/aiReadback')>(),
    AiReadbackPlayer: class { constructor(options: { audio?: AudioContext; sessionId: string; getToken?: () => string }) { mock.players.push(options) } enqueue = mock.enqueue; interrupt = mock.interrupt; close = mock.close; start = mock.start }
}))
beforeEach(() => {
    vi.stubGlobal('AudioContext', class { state = 'running'; resume = vi.fn(async () => {}); close = vi.fn(async () => {}) })
})
afterEach(() => { cleanup(); mock.players = []; mock.liveBySession.clear(); vi.unstubAllGlobals(); localStorage.clear(); mock.messages = []; vi.clearAllMocks() })
function message(seq: number, text: string): DecryptedMessage {
    return { id: `m${seq}`, seq, localId: null, createdAt: Date.now() + 100, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: text } } } }
}

it('reads new AI output independently of sends, skips history, and unsubscribes when turned off', async () => {
    mock.messages = [message(1, 'Old history')]
    const { result } = renderHook(() => useAiReadback({ api: { getMessages: async () => ({ messages: [message(1, 'Old history')] }) } as unknown as ApiClient, sessionId: 's1', baseUrl: '', token: '' }))
    await act(async () => result.current.toggle())
    expect(mock.enqueue).not.toHaveBeenCalled()
    mock.messages.push(message(2, 'Output from a keyboard request'))
    act(() => mock.listener?.())
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('Output from a keyboard request', undefined, expect.any(String), false)
    act(() => mock.listener?.())
    expect(mock.enqueue).toHaveBeenCalledOnce()
    act(() => result.current.toggle())
    expect(mock.listener).toBeNull()
    expect(mock.close).toHaveBeenCalledOnce()
    expect(result.current.enabled).toBe(false)
})


it('reads only the last reply of a turn when final-only is on', async () => {
    localStorage.setItem('hapi.readbackFinalOnly', 'true')
    const { result } = renderHook(() => useAiReadback({ api: { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient, sessionId: 's1', baseUrl: '', token: '' }))
    await act(async () => result.current.toggle())
    const ready = (seq: number): DecryptedMessage => ({ id: `r${seq}`, seq, localId: null, createdAt: Date.now(), content: { role: 'agent', content: { type: 'event', data: { type: 'ready' } } } })
    act(() => { mock.live?.(message(1, 'Checking the logs first.')); mock.live?.(message(2, 'All tests pass.')) })
    expect(mock.enqueue).not.toHaveBeenCalled()
    act(() => mock.live?.(ready(3)))
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('All tests pass.', undefined, expect.any(String), false)
})

it('remembers enabled state and reconnects for the newly selected session only', async () => {
    const api = { getMessages: vi.fn(async () => ({ messages: [] })) } as unknown as ApiClient
    const { result, rerender, unmount } = renderHook(({ sessionId }) => useAiReadback({ api, sessionId, baseUrl: '', token: '' }), { initialProps: { sessionId: 's1' } })
    await act(async () => result.current.toggle())
    expect(localStorage.getItem('hapi.aiReadbackEnabled')).toBe('true')
    await act(async () => rerender({ sessionId: 's2' }))
    expect(result.current.enabled).toBe(true)
    expect(mock.close).toHaveBeenCalledOnce()
    expect(mock.start).toHaveBeenCalledTimes(2)
    expect(mock.players[0].audio).toBe(mock.players[1].audio)
    unmount()
    const next = renderHook(() => useAiReadback({ api, sessionId: 's2', baseUrl: '', token: '' }))
    await act(async () => {})
    expect(next.result.current.enabled).toBe(true)
    expect(mock.start).toHaveBeenCalledTimes(3)
    act(() => next.result.current.toggle())
    expect(localStorage.getItem('hapi.aiReadbackEnabled')).toBe('false')
})

it('ignores a late history request from a previous session', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    let resolve!: (value: { messages: DecryptedMessage[] }) => void
    const api = { getMessages: vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ messages: [] }) } as unknown as ApiClient
    const { rerender } = renderHook(({ sessionId }) => useAiReadback({ api, sessionId, baseUrl: '', token: '' }), { initialProps: { sessionId: 's1' } })
    await act(async () => rerender({ sessionId: 's2' }))
    await act(async () => resolve({ messages: [] }))
    expect(mock.start).toHaveBeenCalledTimes(2)
    mock.messages = [message(2, 'Only current session output')]
    act(() => mock.listener?.())
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('Only current session output', undefined, expect.any(String), false)
})


it('does not lose new output received while the initial history boundary is loading', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    let resolve!: (value: { messages: DecryptedMessage[] }) => void
    const api = { getMessages: () => new Promise(r => { resolve = r }) } as unknown as ApiClient
    renderHook(() => useAiReadback({ api, sessionId: 's2', baseUrl: '', token: '' }))
    const output = message(20, 'New output after switching')
    act(() => mock.live?.(output))
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('New output after switching', undefined, expect.any(String), false)
    mock.messages = [output]
    await act(async () => resolve({ messages: [output] }))
    act(() => mock.listener?.())
    act(() => mock.live?.(output))
    expect(mock.enqueue).toHaveBeenCalledOnce()
})


it('interrupts current playback without changing the persistent enabled setting', async () => {
    const api = { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient
    const { result } = renderHook(() => useAiReadback({ api, sessionId: 's1', baseUrl: '', token: '' }))
    await act(async () => result.current.toggle())
    act(() => result.current.interrupt())
    expect(mock.interrupt).toHaveBeenCalledOnce()
    expect(result.current.enabled).toBe(true)
    expect(localStorage.getItem('hapi.aiReadbackEnabled')).toBe('true')
})


it('replays the latest turn with focus without enabling automatic readback', async () => {
    const api = { getMessages: async () => ({ messages: [message(2, 'First result'), message(3, 'Final result')], page: { hasMore: false } }) } as unknown as ApiClient
    const { result } = renderHook(() => useAiReadback({ api, sessionId: 'current', baseUrl: '', token: '' }))
    await act(async () => result.current.replayLatest('Tests'))
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('First result\n\nFinal result', 'Tests')
    expect(result.current.enabled).toBe(false)
    expect(localStorage.getItem('hapi.aiReadbackEnabled')).not.toBe('true')
})

it('does not replay a late response from a previously selected session', async () => {
    let resolve!: (value: unknown) => void
    const api = { getMessages: () => new Promise(r => { resolve = r }) } as unknown as ApiClient
    const { result, rerender } = renderHook(({ sessionId }) => useAiReadback({ api, sessionId, baseUrl: '', token: '' }), { initialProps: { sessionId: 'old' } })
    let request!: Promise<void>
    act(() => { request = result.current.replayLatest() })
    rerender({ sessionId: 'new' })
    await act(async () => { resolve({ messages: [message(3, 'Old response')], page: { hasMore: false } }); await request })
    expect(mock.enqueue).not.toHaveBeenCalled()
})

it('keeps automatic playback and queued output when authentication refreshes', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    const getMessages = vi.fn(async () => ({ messages: [] }))
    const api = { getMessages } as unknown as ApiClient
    const { rerender } = renderHook(({ token }) => useAiReadback({ api, sessionId: 's1', baseUrl: '', token }), {
        initialProps: { token: 'initial-token' }
    })
    await act(async () => {})
    act(() => mock.live?.(message(1, 'Keep reading this reply')))
    await act(async () => rerender({ token: 'refreshed-token' }))
    expect(mock.close).not.toHaveBeenCalled()
    expect(mock.start).toHaveBeenCalledOnce()
    expect(mock.players[0].getToken?.()).toBe('refreshed-token')
    expect(getMessages).toHaveBeenCalledOnce()
    act(() => mock.live?.(message(2, 'Then read the next reply')))
    expect(mock.enqueue.mock.calls.map(([text]) => text)).toEqual(['Keep reading this reply', 'Then read the next reply'])
})

it('closes a manual replay when switching hubs even if the session ID is unchanged', async () => {
    const api = { getMessages: async () => ({ messages: [message(1, 'Read this reply')], page: { hasMore: false } }) } as unknown as ApiClient
    const { result, rerender } = renderHook(({ baseUrl, token }) => useAiReadback({ api, sessionId: 's1', baseUrl, token }), {
        initialProps: { baseUrl: 'https://first.example', token: 'first-token' }
    })
    await act(async () => result.current.replayLatest())
    expect(mock.start).toHaveBeenCalledOnce()
    await act(async () => rerender({ baseUrl: 'https://second.example', token: 'second-token' }))
    expect(mock.close).toHaveBeenCalledOnce()
})

it('subscribes only to the open conversation and favorites, and starts background readers lazily', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    const api = { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient
    const sessions = [
        { id: 'starred', favorite: true },
        { id: 'ordinary', favorite: false }
    ] as import('@/types/api').SessionSummary[]
    renderHook(() => useAiReadback({ api, sessionId: 'current', baseUrl: '', token: '', sessions }))
    await act(async () => {})
    expect([...mock.liveBySession.keys()].sort()).toEqual(['current', 'starred'])
    expect(mock.players.map(player => player.sessionId)).toEqual(['current'])
    act(() => mock.liveBySession.get('starred')?.(message(1, 'Favorite update')))
    expect(mock.players.map(player => player.sessionId)).toEqual(['current', 'starred'])
    expect(mock.enqueue).toHaveBeenCalledWith('Favorite update', undefined, expect.any(String), false)
})

it('removes queued background readers when a session is unfavorited', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    const api = { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient
    const { rerender } = renderHook(({ favorite }) => useAiReadback({
        api, sessionId: 'current', baseUrl: '', token: '',
        sessions: [{ id: 'starred', favorite }] as import('@/types/api').SessionSummary[]
    }), { initialProps: { favorite: true } })
    await act(async () => {})
    act(() => mock.liveBySession.get('starred')?.(message(1, 'Favorite update')))
    await act(async () => rerender({ favorite: false }))
    expect(mock.close).toHaveBeenCalledOnce()
    expect(mock.liveBySession.has('starred')).toBe(false)
})

it('silences an ordinary background tab when another HAPI window selects a conversation', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    const api = { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient
    renderHook(() => useAiReadback({ api, sessionId: 'current', baseUrl: '', token: '' }))
    await act(async () => {})
    act(() => {
        localStorage.setItem('hapi.readbackSelection', JSON.stringify({ tab: 'other-tab', hub: '', session: 'other' }))
        window.dispatchEvent(new StorageEvent('storage', { key: 'hapi.readbackSelection' }))
    })
    expect(mock.close).toHaveBeenCalledOnce()
    act(() => mock.liveBySession.get('current')?.(message(1, 'Do not read a background non-favorite')))
    expect(mock.enqueue).not.toHaveBeenCalled()
})

it('persists language changes without rebuilding active playback', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    const api = { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient
    const { result } = renderHook(() => useAiReadback({ api, sessionId: 'current', baseUrl: '', token: '' }))
    await act(async () => {})
    expect(result.current.language).toBe('zh')
    act(() => result.current.setLanguage('en'))
    expect(result.current.language).toBe('en')
    expect(localStorage.getItem('hapi.readbackLanguage')).toBe('en')
    expect(mock.close).not.toHaveBeenCalled()
    expect(mock.start).toHaveBeenCalledOnce()
})

it('does not interrupt playback when another tab opens the same conversation', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    vi.stubGlobal('navigator', { locks: {} })
    const api = { getMessages: async () => ({ messages: [] }) } as unknown as ApiClient
    renderHook(() => useAiReadback({ api, sessionId: 'current', baseUrl: '', token: '' }))
    await act(async () => {})
    act(() => {
        localStorage.setItem('hapi.readbackSelection', JSON.stringify({ tab: 'other-tab', hub: '', session: 'current' }))
        window.dispatchEvent(new StorageEvent('storage', { key: 'hapi.readbackSelection' }))
    })
    expect(mock.close).not.toHaveBeenCalled()
    expect(mock.start).toHaveBeenCalledOnce()
})
