import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import type { DecryptedMessage } from '@/types/api'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import { mergeMessages } from '@/lib/messages'

let nextSeq = 0

function message(content: unknown): DecryptedMessage {
    nextSeq += 1
    return { id: `m${nextSeq}`, seq: nextSeq, localId: null, createdAt: 1_000 + nextSeq, content }
}

function userText(text: string): DecryptedMessage {
    return message({ role: 'user', content: { type: 'text', text } })
}

function toolCall(id: string, usage?: unknown): DecryptedMessage {
    return message({
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: `api-${id}`,
                    content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/${id}.ts` } }],
                    ...(usage ? { usage } : {})
                }
            }
        }
    })
}

function toolResult(id: string): DecryptedMessage {
    return message({
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'body' }] }
            }
        }
    })
}

/** The compacted shape the hub returns for a complete tool run. */
function compactedGroup(
    ids: string[],
    firstSeq: number,
    lastSeq: number,
    usage?: unknown
): DecryptedMessage {
    return {
        id: `tool-group:m${firstSeq}`,
        seq: firstSeq,
        localId: null,
        createdAt: 1_000 + firstSeq,
        content: {
            role: 'agent',
            content: {
                type: 'tool-group',
                groupId: `tool-group:${ids[0]}`,
                firstSeq,
                lastSeq,
                absorbedSeqs: Array.from({ length: lastSeq - firstSeq + 1 }, (_, i) => firstSeq + i),
                tools: ids.map((id, index) => ({
                    id,
                    name: 'Read',
                    input: { file_path: `/${id}.ts` },
                    description: null,
                    state: 'completed',
                    createdAt: 1_000 + firstSeq + index * 2,
                    startedAt: 1_000 + firstSeq + index * 2,
                    completedAt: 1_001 + firstSeq + index * 2,
                    resultPending: true
                })),
                ...(usage ? { usage } : {})
            }
        }
    }
}

function usageOf(messages: DecryptedMessage[]) {
    const normalized = messages
        .map((entry) => normalizeDecryptedMessage(entry))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    return reduceChatBlocks(normalized, null).latestUsage
}

function groupsOf(messages: DecryptedMessage[]): ToolGroupBlock[] {
    const normalized = messages
        .map((entry) => normalizeDecryptedMessage(entry))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    const reduced = reduceChatBlocks(normalized, null)
    return buildVisibleChatBlocks(reduced.blocks).filter(isToolGroupBlock)
}

describe('tool group stability across pagination', () => {
    it('keeps rendered group ids and membership when older history is prepended', () => {
        nextSeq = 0
        const older = [userText('first turn'), toolCall('a'), toolResult('a'), toolCall('b'), toolResult('b')]
        const newest = [userText('second turn'), toolCall('c'), toolResult('c'), toolCall('d'), toolResult('d')]

        const before = groupsOf(newest)
        expect(before.map((group) => group.id)).toEqual(['tool-group:c'])

        const after = groupsOf(mergeMessages(older, newest))
        expect(after.map((group) => group.id)).toEqual(['tool-group:a', 'tool-group:c'])
        // The group that was already on screen is untouched.
        expect(after[1].tools.map((tool) => tool.id)).toEqual(before[0].tools.map((tool) => tool.id))
    })

    it('renders a hub-compacted run exactly like the same run delivered raw', () => {
        nextSeq = 0
        const raw = [userText('go'), toolCall('a'), toolResult('a'), toolCall('b'), toolResult('b')]
        const rawGroups = groupsOf(raw)

        const compacted = groupsOf([userText('go'), compactedGroup(['a', 'b'], 2, 5)])

        expect(compacted.map((group) => group.id)).toEqual(rawGroups.map((group) => group.id))
        expect(compacted[0].tools.map((tool) => tool.id)).toEqual(rawGroups[0].tools.map((tool) => tool.id))
        expect(compacted[0].summary).toEqual(rawGroups[0].summary)
        expect(compacted[0].tools.every((tool) => tool.tool.resultPending)).toBe(true)
    })

    it('reports the same token usage whether a run arrives raw or compacted', () => {
        nextSeq = 0
        const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1 }
        const raw = [toolCall('a', usage), toolResult('a'), toolCall('b', usage), toolResult('b')]
        const rawUsage = usageOf(raw)

        const compacted = usageOf([compactedGroup(['a', 'b'], 1, 4, {
            input_tokens: 20,
            output_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 2
        })])

        expect(rawUsage?.totalTokens).toBe(compacted?.totalTokens)
        expect(rawUsage?.totalInputTokens).toBe(compacted?.totalInputTokens)
        expect(rawUsage?.totalOutputTokens).toBe(compacted?.totalOutputTokens)
    })

    it('drops raw messages a compacted group already covers', () => {
        nextSeq = 0
        const streamed = [toolCall('a'), toolResult('a'), toolCall('b'), toolResult('b')]
        const merged = mergeMessages(streamed, [compactedGroup(['a', 'b'], 1, 4)])

        expect(merged).toHaveLength(1)
        expect(groupsOf(merged)[0].tools.map((tool) => tool.id)).toEqual(['a', 'b'])
    })

    it('keeps messages inside a span that the group does not stand for', () => {
        nextSeq = 0
        const calls = [toolCall('a'), toolResult('a'), toolCall('b'), toolResult('b')]
        // The hub delivers this reasoning message alongside the group; the merge
        // must not mistake "inside the span" for "replaced by the group".
        const thinking = message({
            role: 'agent',
            content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] } } }
        })
        const group = compactedGroup(['a', 'b'], 1, 4)
        ;(group.content as { content: { absorbedSeqs: number[] } }).content.absorbedSeqs = [1, 2, 3, 4]

        const merged = mergeMessages(calls, [group, thinking])

        expect(merged.map((entry) => entry.id)).toEqual(['tool-group:m1', thinking.id])
    })

    it('leaves messages outside a group span alone', () => {
        nextSeq = 0
        const prompt = userText('go')
        const streamed = [toolCall('a'), toolResult('a')]
        const merged = mergeMessages([prompt, ...streamed], [compactedGroup(['a', 'b'], 2, 3)])

        expect(merged.map((entry) => entry.id)).toEqual([prompt.id, 'tool-group:m2'])
    })
})
