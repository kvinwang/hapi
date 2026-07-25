import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

type IndexedThreadMessage = {
    id: string
    role: string
    metadata: { custom?: unknown }
}

export type AssistantMessageIndex = {
    forkSeqById: ReadonlyMap<string, number | null>
    lastMessageId: string | null
}

const cache = new WeakMap<readonly IndexedThreadMessage[], AssistantMessageIndex>()

export function getAssistantMessageIndex(messages: readonly IndexedThreadMessage[]): AssistantMessageIndex {
    const cached = cache.get(messages)
    if (cached) return cached

    const forkSeqById = new Map<string, number | null>()
    let nextUserSeq: number | null = null
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.role === 'user') {
            const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
            nextUserSeq = typeof custom?.seq === 'number' ? custom.seq : null
        } else if (message.role === 'assistant') {
            forkSeqById.set(message.id, nextUserSeq === null ? null : nextUserSeq - 1)
        }
    }

    const result = {
        forkSeqById,
        lastMessageId: messages.at(-1)?.id ?? null
    }
    cache.set(messages, result)
    return result
}
