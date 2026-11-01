import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import { useAiReadback } from './useAiReadback'

const mock = vi.hoisted(() => ({ listener: null as (() => void) | null, messages: [] as DecryptedMessage[], enqueue: vi.fn(), close: vi.fn(), start: vi.fn(async () => {}) }))
vi.mock('@/lib/message-window-store', () => ({
    getMessageWindowState: () => ({ messages: mock.messages, pending: [], newestSeq: mock.messages.at(-1)?.seq ?? null }),
    subscribeMessageWindow: (_id: string, listener: () => void) => { mock.listener = listener; return () => { mock.listener = null } }
}))
vi.mock('@/lib/aiReadback', async (original) => ({
    ...await original<typeof import('@/lib/aiReadback')>(),
    AiReadbackPlayer: class { enqueue = mock.enqueue; close = mock.close; start = mock.start }
}))
afterEach(() => { cleanup(); localStorage.clear(); mock.messages = []; vi.clearAllMocks() })
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
    expect(mock.start).toHaveBeenCalledOnce()
    mock.messages = [message(2, 'Only current session output')]
    act(() => mock.listener?.())
    expect(mock.enqueue).toHaveBeenCalledExactlyOnceWith('Only current session output')
})
