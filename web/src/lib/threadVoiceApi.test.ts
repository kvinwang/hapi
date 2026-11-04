import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ThreadMessage } from '@hapi/protocol/threads'
import { createThreadVoiceApi, threadVoiceKey, threadVoiceMessage } from './threadVoiceApi'
import { aiReadbackText, latestAiTurn } from './aiReadback'
import { clearMessageWindow } from './message-window-store'

const messages: ThreadMessage[] = [
    { id: 'user', threadId: 't', seq: 1, sender: { kind: 'user' }, text: 'Review this', mentions: [], receipts: [], createdAt: 1 },
    { id: 'agent', threadId: 't', seq: 2, sender: { kind: 'session', sessionId: 'worker' }, text: 'Review complete.', mentions: [], receipts: [], createdAt: 2 }
]
afterEach(() => clearMessageWindow(threadVoiceKey('t')))
it('sends voice drafts only to the thread and refreshes its conversation', async () => {
    const request = vi.fn(async () => ({ message: messages[0] }))
    const sessionSend = vi.fn()
    const resume = vi.fn()
    const onSent = vi.fn()
    const api = { threadRequest: request, sendMessage: sessionSend, resumeSession: resume } as unknown as ApiClient
    const voice = createThreadVoiceApi(api, 't', onSent)
    expect(await voice.resumeSession('thread:t')).toBe('thread:t')
    await voice.sendMessage('thread:t', 'Voice draft', 'local-1')
    expect(request).toHaveBeenCalledWith('/t/send', { text: 'Voice draft', mentions: [], clientMessageId: expect.any(String) })
    expect(onSent).toHaveBeenCalledOnce()
    expect(sessionSend).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
})
it('uses the thread voice context and converts AI messages for existing readback', async () => {
    const context = vi.fn(async () => ({ title: 'Thread', context: 'Review complete.' }))
    const request = vi.fn(async () => ({ messages, hasMore: false }))
    const api = { getThreadOmniVoiceSession: context, threadRequest: request } as unknown as ApiClient
    const voice = createThreadVoiceApi(api, 't', () => {})
    await voice.getOmniVoiceSession('thread:t')
    expect(context).toHaveBeenCalledWith('t')
    expect(aiReadbackText(threadVoiceMessage(messages[1]))).toBe('Review complete.')
    expect(aiReadbackText(threadVoiceMessage(messages[0]))).toBeNull()
    expect(await latestAiTurn(voice, 'thread:t')).toBe('Review complete.')
    expect(request).toHaveBeenCalledWith('/t/history?limit=100')
    await expect(voice.interruptSession('thread:t')).rejects.toThrow('individual session')
})
