import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { forgetConversation, useConversationHistory } from './useConversationHistory'

afterEach(() => { cleanup(); localStorage.clear() })
it('remembers both conversations independently across remounts and keeps the thread return target', () => {
    const first = renderHook(() => useConversationHistory('hub-a'))
    act(() => {
        first.result.current.remember('sessions', 'session-one')
        first.result.current.remember('threads', 'thread-one', 'session-one')
    })
    first.unmount()
    const next = renderHook(() => useConversationHistory('hub-a'))
    expect(next.result.current.history).toEqual({ sessions: { id: 'session-one' }, threads: { id: 'thread-one', fromSession: 'session-one' } })
    act(() => next.result.current.remember('sessions', 'session-two'))
    expect(next.result.current.history.threads).toEqual({ id: 'thread-one', fromSession: 'session-one' })
    act(() => next.result.current.remember('sessions', 'new'))
    expect(next.result.current.history.sessions?.id).toBe('session-two')
})
it('isolates hubs and rejects corrupt or external stored navigation targets', () => {
    localStorage.setItem('hapi.conversation-history:hub-a', JSON.stringify({ sessions: { id: '//example.com' }, threads: { id: 'thread-a', fromSession: '/sessions/x' } }))
    const { result, rerender } = renderHook(({ hub }) => useConversationHistory(hub), { initialProps: { hub: 'hub-a' } })
    expect(result.current.history).toEqual({ threads: { id: 'thread-a' } })
    rerender({ hub: 'hub-b' })
    expect(result.current.history).toEqual({})
    act(() => result.current.remember('sessions', 'session-b'))
    rerender({ hub: 'hub-a' })
    expect(result.current.history).toEqual({ threads: { id: 'thread-a' } })
})

it('clears a deleted conversation without losing the other tab', () => {
    const { result } = renderHook(() => useConversationHistory('hub-a'))
    act(() => { result.current.remember('sessions', 'deleted'); result.current.remember('threads', 'keep') })
    act(() => forgetConversation('sessions', 'unrelated', 'hub-a'))
    expect(result.current.history.sessions?.id).toBe('deleted')
    act(() => forgetConversation('sessions', 'deleted', 'hub-a'))
    expect(result.current.history).toEqual({ threads: { id: 'keep' } })
})
