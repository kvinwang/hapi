import { describe, expect, it } from 'vitest'
import { getAssistantMessageIndex } from './assistant-message-index'

function entry(id: string, role: string, seq?: number) {
    return {
        id,
        role,
        metadata: { custom: typeof seq === 'number' ? { seq } : undefined }
    }
}

describe('assistant message index', () => {
    it('computes all fork sequences in one reverse pass and caches by message array', () => {
        const messages = [
            entry('assistant-1', 'assistant'),
            entry('assistant-2', 'assistant'),
            entry('user-1', 'user', 10),
            entry('assistant-3', 'assistant'),
        ]

        const first = getAssistantMessageIndex(messages)
        const second = getAssistantMessageIndex(messages)

        expect(second).toBe(first)
        expect(first.forkSeqById.get('assistant-1')).toBe(9)
        expect(first.forkSeqById.get('assistant-2')).toBe(9)
        expect(first.forkSeqById.get('assistant-3')).toBeNull()
        expect(first.lastMessageId).toBe('assistant-3')
    })
})
