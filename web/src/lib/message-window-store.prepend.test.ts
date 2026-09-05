import { describe, expect, it, beforeEach } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    VISIBLE_WINDOW_SIZE,
    catchUpMessagesAfterReconnect,
    clearMessageWindow,
    fetchNewerMessages,
    fetchOlderMessages,
    fetchLatestMessages,
    focusMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    setAtBottom,
    snapToLatestMessages,
} from '@/lib/message-window-store'

describe('reconnect catch-up', () => {
    const sessionId = 'sess-reconnect-catch-up'

    beforeEach(() => {
        clearMessageWindow(sessionId)
    })

    it('loads every page after the newest locally known sequence', async () => {
        ingestIncomingMessages(sessionId, Array.from({ length: 10 }, (_, index) => msg(index + 1)))
        const missing = Array.from({ length: 451 }, (_, index) => msg(index + 11))
        const requestedAfter: number[] = []
        const api = {
            getMessages: async (_sessionId: string, options: { afterSeq?: number; limit?: number }) => {
                const afterSeq = options.afterSeq ?? 0
                requestedAfter.push(afterSeq)
                const messages = missing.filter((message) => message.seq! > afterSeq).slice(0, options.limit)
                const nextAfterSeq = messages.at(-1)?.seq ?? null
                return {
                    messages,
                    page: {
                        hasMore: missing.some((message) => message.seq! > (nextAfterSeq ?? afterSeq)),
                        nextAfterSeq,
                        nextBeforeSeq: null,
                    },
                }
            },
        } as unknown as ApiClient

        await catchUpMessagesAfterReconnect(api, sessionId)

        const state = getMessageWindowState(sessionId)
        expect(requestedAfter).toEqual([10, 210, 410])
        expect(state.newestSeq).toBe(461)
        expect(state.messages).toHaveLength(VISIBLE_WINDOW_SIZE)
        expect(state.messages.map((message) => message.seq)).toEqual(
            Array.from({ length: VISIBLE_WINDOW_SIZE }, (_, index) => index + 62)
        )
    })
})

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

describe('Go to latest during older pagination', () => {
    const sessionId = 'sess-snap-cancels-older'

    beforeEach(() => {
        clearMessageWindow(sessionId)
    })

    it('discards an older page that resolves after the window snaps to latest', async () => {
        const latest = Array.from({ length: 50 }, (_, index) => msg(1000 + index))
        let resolveOlder!: (value: {
            messages: DecryptedMessage[]
            page: { hasMore: boolean; nextAfterSeq: null; nextBeforeSeq: null }
        }) => void
        const api = {
            getMessages: async (_sessionId: string, options: { beforeSeq: number | null }) => {
                if (options.beforeSeq === null) {
                    return {
                        messages: latest,
                        page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null },
                    }
                }
                return await new Promise((resolve) => {
                    resolveOlder = resolve
                })
            },
        } as unknown as ApiClient

        await fetchLatestMessages(api, sessionId)
        const olderRequest = fetchOlderMessages(api, sessionId)
        await Promise.resolve()
        await snapToLatestMessages(api, sessionId)
        resolveOlder({
            messages: [msg(999)],
            page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null },
        })
        await olderRequest

        const state = getMessageWindowState(sessionId)
        expect(state.messages).toEqual(latest)
        expect(state.hasNewer).toBe(false)
        expect(state.isLoadingMore).toBe(false)
    })
})

describe('fetchOlderMessages skips tool-only pages', () => {
    const sessionId = 'sess-skip-tools'

    beforeEach(() => {
        clearMessageWindow(sessionId)
    })

    it('keeps loading older pages until a normal text message appears', async () => {
        clearMessageWindow(sessionId)
        const many = Array.from({ length: VISIBLE_WINDOW_SIZE + 5 }, (_, i) => msg(500 + i, `recent ${i}`))
        ingestIncomingMessages(sessionId, many)
        let state = getMessageWindowState(sessionId)
        expect(state.hasMore).toBe(true)

        // Claude-style tool-only assistant messages (no prose text)
        const toolOnlyPage = (start: number): DecryptedMessage[] =>
            Array.from({ length: 10 }, (_, i) => ({
                id: `tool-${start + i}`,
                seq: start + i,
                createdAt: start + i,
                localId: null,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                role: 'assistant',
                                content: [{
                                    type: 'tool_use',
                                    id: `tc-${start + i}`,
                                    name: 'Bash',
                                    input: { command: `echo ${start + i}` },
                                }],
                            },
                        },
                    },
                },
            })) as DecryptedMessage[]

        const textPage: DecryptedMessage[] = [
            {
                id: 'user-old',
                seq: 100,
                createdAt: 100,
                localId: null,
                content: { role: 'user', content: { type: 'text', text: 'original question' } },
            } as DecryptedMessage,
        ]

        let call = 0
        const visibleCountBeforeLoad = state.messages.length
        const api = {
            getMessages: async () => {
                call += 1
                // Tool-only pages are accumulated without rebuilding the visible
                // window after every network response.
                expect(getMessageWindowState(sessionId).messages).toHaveLength(visibleCountBeforeLoad)
                if (call === 1) {
                    return {
                        messages: toolOnlyPage(200),
                        page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null },
                    }
                }
                if (call === 2) {
                    return {
                        messages: toolOnlyPage(150),
                        page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null },
                    }
                }
                return {
                    messages: textPage,
                    page: { hasMore: false, nextAfterSeq: null, nextBeforeSeq: null },
                }
            },
        } as unknown as ApiClient

        await fetchOlderMessages(api, sessionId)
        state = getMessageWindowState(sessionId)

        expect(call).toBe(3)
        expect(state.messages.some((m) => m.id === 'user-old')).toBe(true)
        expect(state.hasNewer).toBe(false)
    })

    it('does not stop at orphaned sidechain text that renders no root block', async () => {
        const many = Array.from({ length: VISIBLE_WINDOW_SIZE + 5 }, (_, i) => msg(500 + i, `recent ${i}`))
        ingestIncomingMessages(sessionId, many)

        const sidechainPage = [{
            id: 'sidechain-text',
            seq: 200,
            createdAt: 200,
            localId: null,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        isSidechain: true,
                        uuid: 'child-message',
                        parentUuid: 'missing-parent',
                        message: { content: [{ type: 'text', text: 'subagent progress' }] },
                    },
                },
            },
        }] as DecryptedMessage[]
        const rootPage = [msg(100, 'visible root prompt')]
        let call = 0
        const api = {
            getMessages: async () => {
                call += 1
                return call === 1
                    ? { messages: sidechainPage, page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null } }
                    : { messages: rootPage, page: { hasMore: false, nextAfterSeq: null, nextBeforeSeq: null } }
            },
        } as unknown as ApiClient

        await fetchOlderMessages(api, sessionId)

        expect(call).toBe(2)
        expect(getMessageWindowState(sessionId).messages.some((message) => message.id === 'id-100')).toBe(true)
    })
})

function agentMsg(seq: number, text = `a${seq}`): DecryptedMessage {
    return {
        id: `agent-${seq}`,
        seq,
        content: { role: 'assistant', content: { type: 'text', text } },
        createdAt: seq,
        localId: null,
    } as DecryptedMessage
}

describe('ingest while scrolled up (not atBottom)', () => {
    const sessionId = 'sess-ingest-scrolled-up'

    beforeEach(() => {
        clearMessageWindow(sessionId)
    })

    it('never drops older messages the user may be reading when agent messages stream in', () => {
        // Fill the window beyond capacity while at bottom so hasMore is set.
        const many = Array.from({ length: VISIBLE_WINDOW_SIZE + 10 }, (_, i) => msg(100 + i))
        ingestIncomingMessages(sessionId, many)
        let state = getMessageWindowState(sessionId)
        expect(state.messages.length).toBe(VISIBLE_WINDOW_SIZE)
        const oldestVisibleSeq = state.messages[0]?.seq

        // User scrolls up to read history.
        setAtBottom(sessionId, false)

        // Agent keeps streaming; window would exceed VISIBLE_WINDOW_SIZE.
        const streamed = Array.from({ length: 30 }, (_, i) => agentMsg(2000 + i))
        ingestIncomingMessages(sessionId, streamed)

        state = getMessageWindowState(sessionId)
        // Older messages must stay on screen (no top trim while reading).
        expect(state.messages[0]?.seq).toBe(oldestVisibleSeq)
        expect(state.messages.length).toBe(VISIBLE_WINDOW_SIZE + 30)
        // Streamed agent messages are appended even while scrolled up.
        expect(state.messages[state.messages.length - 1]?.seq).toBe(2000 + 29)
    })
})

describe('fetchNewerMessages while browsing history', () => {
    const sessionId = 'sess-newer-keeps-older'

    beforeEach(() => {
        clearMessageWindow(sessionId)
    })

    it('does not drop older messages from the top when paging forward', async () => {
        const targetSeq = 500
        const beforePage = Array.from({ length: 160 }, (_, i) => msg(targetSeq - 159 + i))
        const afterPage = Array.from({ length: 160 }, (_, i) => msg(targetSeq + 1 + i))
        const newerPage = Array.from({ length: 50 }, (_, i) => msg(targetSeq + 161 + i))

        const api = {
            getMessages: async (_id: string, options: { beforeSeq?: number | null; afterSeq?: number | null }) => {
                if (options.beforeSeq === targetSeq + 1) {
                    return { messages: beforePage, page: { hasMore: true, nextAfterSeq: null, nextBeforeSeq: null } }
                }
                if (options.afterSeq === targetSeq) {
                    return { messages: afterPage, page: { hasMore: true, nextAfterSeq: targetSeq + 160, nextBeforeSeq: null } }
                }
                if (options.afterSeq === targetSeq + 160) {
                    return { messages: newerPage, page: { hasMore: false, nextAfterSeq: null, nextBeforeSeq: null } }
                }
                return { messages: [], page: { hasMore: false, nextAfterSeq: null, nextBeforeSeq: null } }
            },
        } as unknown as ApiClient

        const focused = await focusMessageWindow(api, sessionId, targetSeq)
        expect(focused).toBe(true)
        let state = getMessageWindowState(sessionId)
        expect(state.hasNewer).toBe(true)
        const oldestVisibleSeq = state.messages[0]?.seq
        expect(oldestVisibleSeq).toBe(targetSeq - 159)

        await fetchNewerMessages(api, sessionId)
        state = getMessageWindowState(sessionId)

        // Older side of the window must survive the forward page fetch.
        expect(state.messages[0]?.seq).toBe(oldestVisibleSeq)
        expect(state.messages.length).toBe(320 + 50)
        expect(state.hasNewer).toBe(false)
    })
})
