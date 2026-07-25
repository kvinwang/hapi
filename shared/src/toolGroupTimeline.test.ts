import { describe, expect, it } from 'bun:test'
import {
    buildSealedToolGroups,
    compactMessagesWithToolGroupSummaries,
    type TimelineMessage
} from './toolGroupTimeline'

function toolStart(seq: number, id: string, name = 'Bash'): TimelineMessage {
    return {
        id: `m${seq}`,
        seq,
        createdAt: seq * 1000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        content: [{ type: 'tool_use', id, name, input: { command: 'ls' } }]
                    }
                }
            }
        }
    }
}

function toolResult(seq: number, id: string, isError = false): TimelineMessage {
    return {
        id: `m${seq}`,
        seq,
        createdAt: seq * 1000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }]
                    }
                }
            }
        }
    }
}

function textMessage(seq: number, text: string): TimelineMessage {
    return {
        id: `m${seq}`,
        seq,
        createdAt: seq * 1000,
        content: {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { content: [{ type: 'text', text }] }
                }
            }
        }
    }
}

describe('sealed tool groups', () => {
    it('packs sequential completed tools into one multi-tool group', () => {
        const messages = [
            toolStart(1, 'a'),
            toolResult(2, 'a'),
            toolStart(3, 'b'),
            toolResult(4, 'b'),
            toolStart(5, 'c'),
            toolResult(6, 'c')
        ]
        const groups = buildSealedToolGroups(messages)
        expect(groups).toHaveLength(1)
        expect(groups[0]?.id).toBe('tool-group:a')
        expect(groups[0]?.toolUseIds).toEqual(['a', 'b', 'c'])
        expect(groups[0]?.firstSeq).toBe(1)
        expect(groups[0]?.lastSeq).toBe(6)
    })

    it('splits groups on assistant text boundaries', () => {
        const messages = [
            toolStart(1, 'a'),
            toolStart(2, 'b'),
            toolResult(3, 'a'),
            toolResult(4, 'b'),
            textMessage(5, 'note'),
            toolStart(6, 'c'),
            toolStart(7, 'd'),
            toolResult(8, 'c'),
            toolResult(9, 'd')
        ]
        const groups = buildSealedToolGroups(messages)
        expect(groups).toHaveLength(2)
        expect(groups[0]?.id).toBe('tool-group:a')
        expect(groups[0]?.toolUseIds).toEqual(['a', 'b'])
        expect(groups[1]?.id).toBe('tool-group:c')
        expect(groups[1]?.toolUseIds).toEqual(['c', 'd'])
    })

    it('compacts sealed groups into summary messages', () => {
        const messages = [
            textMessage(1, 'hello'),
            toolStart(2, 'a'),
            toolStart(3, 'b'),
            toolResult(4, 'a'),
            toolResult(5, 'b'),
            textMessage(6, 'done')
        ]
        const compact = compactMessagesWithToolGroupSummaries(messages)
        expect(compact).toHaveLength(3)
        expect(compact[0]?.seq).toBe(1)
        const summary = compact[1]?.content as any
        expect(summary.content.type).toBe('tool-group-summary')
        expect(summary.content.id).toBe('tool-group:a')
        expect(summary.content.firstSeq).toBe(2)
        expect(summary.content.lastSeq).toBe(5)
        expect(compact[2]?.seq).toBe(6)
    })

    it('does not compact single-tool runs', () => {
        const messages = [
            toolStart(1, 'a'),
            toolResult(2, 'a'),
            textMessage(3, 'done')
        ]
        const compact = compactMessagesWithToolGroupSummaries(messages)
        expect(compact).toHaveLength(3)
        expect(compact[0]?.id).toBe('m1')
        expect(compact[1]?.id).toBe('m2')
        expect(compact[2]?.id).toBe('m3')
    })
})
