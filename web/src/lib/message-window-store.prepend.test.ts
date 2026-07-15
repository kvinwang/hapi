import { describe, expect, it, beforeEach } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    VISIBLE_WINDOW_SIZE,
    clearMessageWindow,
    fetchOlderMessages,
    getMessageWindowState,
    ingestIncomingMessages,
} from '@/lib/message-window-store'

function msg(seq: number, text = `m${seq}`): DecryptedMessage {
    return {
        id: `id-${seq}`,
        seq,
        content: { role: 'user', content: { type: 'text', text } },
        createdAt: seq,
        localId: null,
    } as DecryptedMessage
}

describe('fetchOlderMessages prepend trim', () => {
    const sessionId = 'sess-prepend-test'

    beforeEach(() => {
        clearMessageWindow(sessionId)
    })

    it('does not drop the live bottom messages when loading older history', async () => {
        // Seed a full window of "recent" messages (seq 1000+)
        const recent = Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, i) => msg(1000 + i))
        for (const m of recent) {
            ingestIncomingMessages(sessionId, [m])
        }
        // Force at-bottom false isn't needed for fetchOlder; seed via direct state by loading
        const before = getMessageWindowState(sessionId)
        expect(before.messages.length).toBe(VISIBLE_WINDOW_SIZE)
        const bottomSeq = before.messages[before.messages.length - 1]?.seq
        expect(bottomSeq).toBe(1000 + VISIBLE_WINDOW_SIZE - 1)

        const older = Array.from({ length: 50 }, (_, i) => msg(900 + i))
        const api = {
            getMessages: async () => ({
                messages: older,
                page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null },
            }),
        } as unknown as ApiClient

        // Mark hasMore + oldestSeq by manually using fetch path - need state with hasMore
        // ingest only sets append; use internal by calling fetchOlder after setting state via multiple ingests
        // Patch: call fetchOlderMessages only works if hasMore && oldestSeq
        // Seed hasMore by loading more than window... append trim sets hasMore
        // Actually after VISIBLE_WINDOW_SIZE messages at bottom, hasMore may be false.
        // Use a mock by importing and setting - simpler approach: call fetchOlder after
        // inject state through fetchLatestMessages pattern.

        // Directly set hasMore through appending enough and then we need oldestSeq.
        // The store's getMessageWindowState shows oldestSeq from messages.
        // Manually toggle hasMore by using private API - not exported.
        // Workaround: use fetchOlderMessages after building state via (messages full + hasMore from drop older).
        // When we have WINDOW messages from append, hasMore is false unless droppedOlder.
        // Let's add WINDOW+10 then oldest dropped -> hasMore true, at bottom.
        clearMessageWindow(sessionId)
        const many = Array.from({ length: VISIBLE_WINDOW_SIZE + 10 }, (_, i) => msg(100 + i))
        ingestIncomingMessages(sessionId, many)
        let state = getMessageWindowState(sessionId)
        expect(state.hasMore).toBe(true)
        expect(state.messages.length).toBe(VISIBLE_WINDOW_SIZE)
        const liveBottom = state.messages[state.messages.length - 1]?.seq

        const olderPage = Array.from({ length: 50 }, (_, i) => msg(state.oldestSeq! - 50 + i))
        const api2 = {
            getMessages: async () => ({
                messages: olderPage,
                page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null },
            }),
        } as unknown as ApiClient

        await fetchOlderMessages(api2, sessionId)
        state = getMessageWindowState(sessionId)

        // Bottom of the live conversation must still be present
        expect(state.messages.some((m) => m.seq === liveBottom)).toBe(true)
        // Must NOT invent a "Load more" gap at the bottom
        expect(state.hasNewer).toBe(false)
        // Window grew with older pages
        expect(state.messages.length).toBeGreaterThan(VISIBLE_WINDOW_SIZE)
    })
})
