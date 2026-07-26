import { describe, expect, it } from 'vitest'
import { compactToolRuns } from './toolRunPage'
import type { ChatSourceMessage, ToolGroupContent } from './types'

let nextSeq = 0

function message(content: unknown): ChatSourceMessage {
    nextSeq += 1
    return { id: `m${nextSeq}`, seq: nextSeq, localId: null, createdAt: 1_000 + nextSeq, content }
}

function assistant(blocks: unknown[], usage?: unknown): ChatSourceMessage {
    return message({
        role: 'agent',
        content: {
            type: 'output',
            data: { type: 'assistant', message: { content: blocks, ...(usage ? { usage } : {}) } }
        }
    })
}

function toolResult(toolUseId: string): ChatSourceMessage {
    return message({
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `OUT-${toolUseId}` }] }
            }
        }
    })
}

function call(id: string, name = 'Read'): ChatSourceMessage {
    return assistant([{ type: 'tool_use', id, name, input: {} }])
}

function groupOf(messages: readonly ChatSourceMessage[]): ToolGroupContent | null {
    for (const message of messages) {
        const inner = (message.content as { content?: ToolGroupContent }).content
        if (inner && inner.type === 'tool-group') return inner
    }
    return null
}

describe('compactToolRuns', () => {
    it('keeps the result of a tool whose call was announced with prose', () => {
        nextSeq = 0
        // Claude routinely writes "Let me look." in the same turn as the tool
        // call. That message renders on its own, so its result must too.
        const page = [
            assistant([{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
            toolResult('t1'),
            call('t2'),
            toolResult('t2'),
            call('t3'),
            toolResult('t3'),
            assistant([{ type: 'text', text: 'Done.' }])
        ]

        const output = compactToolRuns(page, { sessionMaxSeq: 99 })

        expect(JSON.stringify(output)).toContain('OUT-t1')
        expect(groupOf(output)!.tools.map((tool) => tool.id)).toEqual(['t2', 't3'])
        expect(output.map((message) => message.seq)).toEqual([1, 2, 3, 7])
    })

    it('keeps reasoning and usage-only messages that sit inside a run', () => {
        nextSeq = 0
        const page = [
            call('a'),
            toolResult('a'),
            message({ role: 'agent', content: { type: 'codex', data: { type: 'token_count', info: { total: { total_tokens: 500 } } } } }),
            assistant([{ type: 'thinking', thinking: 'pondering' }]),
            call('b'),
            toolResult('b'),
            assistant([{ type: 'text', text: 'Done.' }])
        ]

        const output = compactToolRuns(page, { sessionMaxSeq: 99 })

        const serialized = JSON.stringify(output)
        expect(serialized).toContain('token_count')
        expect(serialized).toContain('pondering')
        expect(groupOf(output)!.absorbedSeqs).toEqual([1, 2, 5, 6])
    })

    it('only sums usage from the messages it removes', () => {
        nextSeq = 0
        const usage = { input_tokens: 10, output_tokens: 2 }
        const page = [
            assistant([{ type: 'tool_use', id: 'a', name: 'Read', input: {} }], usage),
            toolResult('a'),
            // Stays in the page, so its usage must not also land in the group.
            assistant([{ type: 'thinking', thinking: 'hmm' }], { input_tokens: 100, output_tokens: 50 }),
            assistant([{ type: 'tool_use', id: 'b', name: 'Read', input: {} }], usage),
            toolResult('b'),
            assistant([{ type: 'text', text: 'Done.' }])
        ]

        const output = compactToolRuns(page, { sessionMaxSeq: 99 })

        expect(groupOf(output)!.usage).toMatchObject({ input_tokens: 20, output_tokens: 4 })
    })

    it('does not fold a title change into a tool group', () => {
        nextSeq = 0
        const page = [
            call('a'),
            toolResult('a'),
            call('title', 'mcp__hapi__change_title'),
            toolResult('title'),
            call('b'),
            toolResult('b'),
            assistant([{ type: 'text', text: 'Done.' }])
        ]

        const output = compactToolRuns(page, { sessionMaxSeq: 99 })

        // Neither side reaches two tools, so nothing compacts and the title
        // event renders exactly as it does without tool groups.
        expect(groupOf(output)).toBeNull()
        expect(output).toHaveLength(page.length)
    })
})
