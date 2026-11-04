import type { ApiClient } from '@/api/client'
import type { ThreadInbox, ThreadMessage } from '@hapi/protocol/threads'
import type { DecryptedMessage } from '@/types/api'
import type { VoiceApi } from './voiceApi'
import { ingestIncomingMessages, publishLiveMessage } from './message-window-store'

export const threadVoiceKey = (threadId: string): string => `thread:${threadId}`

export function threadVoiceMessage(message: ThreadMessage): DecryptedMessage {
    return {
        id: message.id,
        seq: message.seq,
        localId: null,
        createdAt: message.createdAt,
        content:
            message.sender.kind === 'user'
                ? { role: 'user', content: { type: 'text', text: message.sender.guest ? `[Guest] ${message.text}` : message.text } }
                : {
                      role: 'agent',
                      content: {
                          type: 'output',
                          data: { type: 'assistant', message: { content: [{ type: 'text', text: message.text }] } }
                      }
                  }
    }
}

/** Adapt voice operations to thread endpoints; never address a coding session with a thread ID. */
export function createThreadVoiceApi(api: ApiClient, threadId: string, onSent: () => void): VoiceApi {
    const key = threadVoiceKey(threadId)
    return {
        getOmniVoiceSession: () => api.getThreadOmniVoiceSession(threadId),
        reportVoiceEvent: (event, detail) => api.reportVoiceEvent(event, detail),
        resumeSession: async () => key,
        interruptSession: async () => {
            throw new Error('Open an individual session to interrupt its agent.')
        },
        getMessages: async (_id, options) => {
            const params = new URLSearchParams({ limit: String(Math.min(options.limit ?? 50, 100)) })
            if (options.beforeSeq != null) params.set('before', String(options.beforeSeq))
            if (options.afterSeq != null) params.set('after', String(options.afterSeq))
            const result = await api.threadRequest<ThreadInbox>(`/${threadId}/history?${params}`)
            return {
                messages: result.messages.map(threadVoiceMessage),
                page: {
                    limit: Number(params.get('limit')),
                    beforeSeq: options.beforeSeq ?? null,
                    afterSeq: options.afterSeq ?? null,
                    nextBeforeSeq: result.messages[0]?.seq ?? null,
                    nextAfterSeq: result.messages.at(-1)?.seq ?? null,
                    hasMore: result.hasMore
                }
            }
        },
        sendMessage: async (_id, text, localId) => {
            const result = await api.threadRequest<{ message: ThreadMessage }>(`/${threadId}/send`, {
                text,
                mentions: [],
                clientMessageId: crypto.randomUUID()
            })
            const message = { ...threadVoiceMessage(result.message), localId: localId ?? null }
            ingestIncomingMessages(key, [message])
            publishLiveMessage(key, message)
            onSent()
            return { seq: result.message.seq }
        }
    }
}
