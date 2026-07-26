import { describe, expect, it } from 'vitest'
import {
    compactToolRuns,
    expandPageStartToRunBoundary,
    normalizeDecryptedMessage,
    type ChatSourceMessage,
    type ToolGroupPageLoader
} from '@hapi/protocol/chat'
import type { DecryptedMessage } from '@/types/api'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import { mergeMessages } from '@/lib/messages'

/**
 * Drives the hub's page projection and the client's grouping over one fixture
 * session, the way the app does when the user scrolls up through history. The
 * point of the whole feature is the assertion at the end: a group the user has
 * already seen never changes.
 */

function claudeAssistant(blocks: unknown[]): unknown {
    return { role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: blocks } } } }
}

function claudeToolResult(toolUseId: string): unknown {
    return {
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'x'.repeat(4_000) }] }
            }
        }
    }
}

/** A session of `turns` turns, each: user prompt, N tool calls, assistant reply. */
function buildSession(turns: number, toolsPerTurn: number): ChatSourceMessage[] {
    const messages: ChatSourceMessage[] = []
    const push = (content: unknown) => {
        messages.push({
            id: `m${messages.length + 1}`,
            seq: messages.length + 1,
            localId: null,
            createdAt: 1_000 + messages.length,
            content
        })
    }
    for (let turn = 0; turn < turns; turn += 1) {
        push({ role: 'user', content: { type: 'text', text: `prompt ${turn}` } })
        for (let tool = 0; tool < toolsPerTurn; tool += 1) {
            const id = `t${turn}-${tool}`
            push(claudeAssistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: `/f${tool}.ts` } }]))
            push(claudeToolResult(id))
        }
        push(claudeAssistant([{ type: 'text', text: `answer ${turn}` }]))
    }
    return messages
}

/** The hub's `?toolGroups=1` before-page, backed by an in-memory session. */
function fetchOlderPage(
    session: ChatSourceMessage[],
    beforeSeq: number | null,
    limit: number
): { messages: ChatSourceMessage[]; hasMore: boolean; nextBeforeSeq: number | null } {
    const loader: ToolGroupPageLoader = {
        loadBefore: (seq, count) => session.filter((m) => m.seq! < seq).slice(-count),
        loadAfter: (seq, count) => session.filter((m) => m.seq! > seq).slice(0, count)
    }
    const upTo = beforeSeq === null ? session : session.filter((m) => m.seq! < beforeSeq)
    const raw = upTo.slice(-limit)
    const expanded = expandPageStartToRunBoundary(raw, loader)
    const messages = compactToolRuns(expanded, { sessionMaxSeq: session[session.length - 1].seq! })

    const oldest = Math.min(...expanded.map((m) => m.seq!))
    return {
        messages,
        hasMore: session.some((m) => m.seq! < oldest),
        nextBeforeSeq: oldest
    }
}

function groupsOf(messages: DecryptedMessage[], previous: ToolGroupBlock[]): ToolGroupBlock[] {
    const normalized = messages
        .map((entry) => normalizeDecryptedMessage(entry))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    const reduced = reduceChatBlocks(normalized, null)
    return buildVisibleChatBlocks(reduced.blocks, { previousGroups: previous })
        .filter(isToolGroupBlock)
}

function fingerprint(group: ToolGroupBlock): string {
    return `${group.id}=${group.tools.map((tool) => tool.id).join(',')}`
}

describe('scrolling back through a tool-dense session', () => {
    it('never changes a tool group the user has already seen', () => {
        const session = buildSession(6, 9)
        const seen = new Map<string, string>()

        let window: DecryptedMessage[] = []
        let groups: ToolGroupBlock[] = []
        let beforeSeq: number | null = null
        let hasMore = true
        let pages = 0

        while (hasMore && pages < 40) {
            pages += 1
            const page = fetchOlderPage(session, beforeSeq, 7)
            window = mergeMessages(page.messages as DecryptedMessage[], window)
            groups = groupsOf(window, groups)

            // Everything rendered by an earlier page must still be there, unchanged.
            const byId = new Map(groups.map((group) => [group.id, fingerprint(group)]))
            for (const [id, previous] of seen) {
                expect(byId.get(id)).toBe(previous)
            }
            for (const [id, current] of byId) seen.set(id, current)

            hasMore = page.hasMore
            beforeSeq = page.nextBeforeSeq
        }

        expect(hasMore).toBe(false)
        // One group per turn, each holding the turn's nine tools.
        expect(groups).toHaveLength(6)
        expect(groups.map((group) => group.tools.length)).toEqual([9, 9, 9, 9, 9, 9])
        expect(groups.map((group) => group.id)).toEqual(
            [0, 1, 2, 3, 4, 5].map((turn) => `tool-group:t${turn}-0`)
        )
    })

    it('leaves the still-growing tail run raw so live tool calls join it', () => {
        const session = buildSession(1, 3).slice(0, -1) // drop the closing assistant text
        const page = fetchOlderPage(session, null, 50)

        // Nothing compacted: the run reaches the newest message.
        expect(page.messages).toHaveLength(session.length)

        const groups = groupsOf(page.messages as DecryptedMessage[], [])
        expect(groups).toHaveLength(1)
        expect(groups[0].tools).toHaveLength(3)

        // A live tool call arrives and extends the same card, keeping its id.
        const live: DecryptedMessage = {
            id: 'live',
            seq: session.length + 1,
            localId: null,
            createdAt: 9_999,
            content: claudeAssistant([{ type: 'tool_use', id: 't0-3', name: 'Read', input: {} }])
        }
        const grown = groupsOf(mergeMessages(page.messages as DecryptedMessage[], [live]), groups)
        expect(grown).toHaveLength(1)
        expect(grown[0].id).toBe(groups[0].id)
        expect(grown[0].tools).toHaveLength(4)
    })
})
