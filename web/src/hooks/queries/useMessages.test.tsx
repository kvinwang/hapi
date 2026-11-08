import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { useMessages } from './useMessages'

afterEach(cleanup)

it('keeps the visible conversation while voice still subscribes and releases it after the last subscriber leaves', async () => {
    const id = 'voice-context-cache'
    const unsubscribeVoice = subscribeMessageWindow(id, vi.fn())
    const messages = [{ id: 'message', seq: 1, createdAt: 1, localId: null, content: { role: 'user', content: { type: 'text', text: 'Current task context' } } }]
    const api = { getMessages: async () => ({ messages, page: { hasMore: false } }) } as unknown as ApiClient
    const { result, unmount } = renderHook(() => useMessages(api, id))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    unmount()
    expect(getMessageWindowState(id).messages).toEqual(messages)
    act(() => unsubscribeVoice())
    expect(getMessageWindowState(id).messages).toEqual([])
})
