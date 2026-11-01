import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { useAiReadback } from './useAiReadback'

const mock = vi.hoisted(() => ({ listener: null as (() => void) | null, live: null as ((message: DecryptedMessage) => void) | null, players: [] as Array<{ audio?: AudioContext; sessionId: string }>, messages: [] as DecryptedMessage[], enqueue: vi.fn(), interrupt: vi.fn(), close: vi.fn(), start: vi.fn(async () => {}) }))
vi.mock('@/lib/message-window-store', () => ({
    getMessageWindowState: () => ({ messages: mock.messages, pending: [], newestSeq: mock.messages.at(-1)?.seq ?? null }),
    subscribeLiveMessages: (_id: string, listener: (message: DecryptedMessage) => void) => { mock.live = listener; return () => { mock.live = null } },
    subscribeMessageWindow: (_id: string, listener: () => void) => { mock.listener = listener; return () => { mock.listener = null } }
}))
vi.mock('@/lib/aiReadback', async (original) => ({
    ...await original<typeof import('@/lib/aiReadback')>(),
    AiReadbackPlayer: class { constructor(options: { audio?: AudioContext; sessionId: string }) { mock.players.push(options) } enqueue = mock.enqueue; interrupt = mock.interrupt; close = mock.close; start = mock.start }
}))
beforeEach(() => { vi.stubGlobal('AudioContext', class { state = 'running'; resume = vi.fn(async () => {}); close = vi.fn(async () => {}) }) })
afterEach(() => { cleanup(); mock.players = []; vi.unstubAllGlobals(); localStorage.clear(); mock.messages = []; vi.clearAllMocks() })
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
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('Output from a keyboard request')
    act(() => mock.listener?.())
    expect(mock.enqueue).toHaveBeenCalledOnce()
    act(() => result.current.toggle())
    expect(mock.listener).toBeNull()
    expect(mock.close).toHaveBeenCalledOnce()
    expect(result.current.enabled).toBe(false)
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
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('Only current session output')
})


it('does not lose new output received while the initial history boundary is loading', async () => {
    localStorage.setItem('hapi.aiReadbackEnabled', 'true')
    let resolve!: (value: { messages: DecryptedMessage[] }) => void
    const api = { getMessages: () => new Promise(r => { resolve = r }) } as unknown as ApiClient
    renderHook(() => useAiReadback({ api, sessionId: 's2', baseUrl: '', token: '' }))
    const output = message(20, 'New output after switching')
    act(() => mock.live?.(output))
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('New output after switching')
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
