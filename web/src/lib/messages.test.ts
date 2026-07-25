import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from './messages'

function message(seq: number, overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
    return {
        id: `message-${seq}`,
        seq,
        createdAt: seq,
        localId: null,
        content: { role: 'user', content: { type: 'text', text: `${seq}` } },
        ...overrides
    } as DecryptedMessage
}

describe('mergeMessages ordered fast paths', () => {
    it('preserves identity for an empty or semantically unchanged merge', () => {
        const existing = [message(1), message(2)]
        expect(mergeMessages(existing, [])).toBe(existing)
        expect(mergeMessages(existing, existing)).toBe(existing)
    })

    it('appends and prepends already ordered disjoint ranges', () => {
        const existing = [message(3), message(4)]
        expect(mergeMessages(existing, [message(5), message(6)]).map((entry) => entry.seq))
            .toEqual([3, 4, 5, 6])
        expect(mergeMessages(existing, [message(1), message(2)]).map((entry) => entry.seq))
            .toEqual([1, 2, 3, 4])
    })

    it('falls back for same-id replacement and optimistic reconciliation', () => {
        const original = message(1)
        const replacement = message(1, { content: { role: 'user', content: { type: 'text', text: 'new' } } })
        expect(mergeMessages([original], [replacement])).toEqual([replacement])

        const optimistic = message(2, { id: 'local-2', localId: 'local-2', status: 'sending' })
        const stored = message(3, { id: 'stored-3', localId: 'local-2' })
        expect(mergeMessages([optimistic], [stored])).toEqual([stored])
    })

    it('sorts unsorted input when the destination is empty', () => {
        expect(mergeMessages([], [message(2), message(1)]).map((entry) => entry.seq)).toEqual([1, 2])
    })
})
