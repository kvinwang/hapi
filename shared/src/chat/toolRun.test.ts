import { describe, expect, it } from 'vitest'
import type { ChatSourceMessage } from './types'
import {
    classifyToolRunMessage,
    collectToolGroupDescriptors,
    findToolRuns,
    getToolGroupSpan,
    truncateToolInput
} from './toolRun'

let nextSeq = 0

function message(content: unknown): ChatSourceMessage {
    nextSeq += 1
    return { id: `m${nextSeq}`, seq: nextSeq, localId: null, createdAt: 1_000 + nextSeq, content }
}

function claudeAssistant(blocks: unknown[]): ChatSourceMessage {
    return message({
        role: 'agent',
        content: { type: 'output', data: { type: 'assistant', message: { content: blocks } } }
    })
}

function claudeToolResult(toolUseId: string, isError = false): ChatSourceMessage {
    return message({
        role: 'agent',
        content: {
            type: 'output',
            data: {
                type: 'user',
                message: {
                    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok', is_error: isError }]
                }
            }
        }
    })
}

function userText(text: string): ChatSourceMessage {
    return message({ role: 'user', content: { type: 'text', text } })
}

describe('classifyToolRunMessage', () => {
    it('treats user prompts and assistant prose as boundaries', () => {
        expect(classifyToolRunMessage(userText('hi'))).toBe('boundary')
        expect(classifyToolRunMessage(claudeAssistant([{ type: 'text', text: 'Let me look.' }]))).toBe('boundary')
    })

    it('treats groupable tool calls and their results as tool activity', () => {
        const call = claudeAssistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } }])
        expect(classifyToolRunMessage(call)).toBe('tool')
        expect(classifyToolRunMessage(claudeToolResult('t1'))).toBe('tool')
    })

    it('treats tools that render standalone as boundaries', () => {
        const todo = claudeAssistant([{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: {} }])
        expect(classifyToolRunMessage(todo)).toBe('boundary')
    })

    it('treats reasoning-only and usage-only messages as transparent', () => {
        const thinking = claudeAssistant([{ type: 'thinking', thinking: 'hmm' }])
        expect(classifyToolRunMessage(thinking)).toBe('transparent')

        const usage = message({ role: 'agent', content: { type: 'codex', data: { type: 'usage', input_tokens: 1, output_tokens: 2 } } })
        expect(classifyToolRunMessage(usage)).toBe('transparent')
    })

    it('treats an assistant turn that mixes prose with tools as a boundary', () => {
        const mixed = claudeAssistant([
            { type: 'text', text: 'Reading now.' },
            { type: 'tool_use', id: 't3', name: 'Read', input: {} }
        ])
        expect(classifyToolRunMessage(mixed)).toBe('boundary')
    })
})

describe('findToolRuns', () => {
    it('groups consecutive tool activity and skips embedded transparency', () => {
        const runs = findToolRuns(['boundary', 'tool', 'transparent', 'tool', 'boundary', 'tool'])
        expect(runs).toEqual([
            { start: 1, end: 3 },
            { start: 5, end: 5 }
        ])
    })

    it('excludes leading and trailing transparent messages', () => {
        const runs = findToolRuns(['transparent', 'tool', 'transparent'])
        expect(runs).toEqual([{ start: 1, end: 1 }])
    })

    it('returns nothing when no tool activity exists', () => {
        expect(findToolRuns(['boundary', 'transparent', 'boundary'])).toEqual([])
    })
})

describe('collectToolGroupDescriptors', () => {
    it('folds calls and results into one descriptor per tool', () => {
        const call1 = claudeAssistant([{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/a.ts' } }])
        const result1 = claudeToolResult('a')
        const call2 = claudeAssistant([{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }])
        const result2 = claudeToolResult('b', true)

        const collected = collectToolGroupDescriptors([call1, result1, call2, result2])
        expect(collected).not.toBeNull()
        expect(collected!.tools.map((tool) => [tool.id, tool.name, tool.state])).toEqual([
            ['a', 'Read', 'completed'],
            ['b', 'Bash', 'error']
        ])
        expect(collected!.tools[0].resultPending).toBe(true)
        expect(collected!.tools[0].completedAt).toBe(result1.createdAt)
    })

    it('leaves a tool without a result in the running state', () => {
        const call1 = claudeAssistant([{ type: 'tool_use', id: 'c', name: 'Read', input: {} }])
        const call2 = claudeAssistant([{ type: 'tool_use', id: 'd', name: 'Read', input: {} }])
        const collected = collectToolGroupDescriptors([call1, call2])
        expect(collected!.tools.map((tool) => tool.state)).toEqual(['running', 'running'])
    })

    it('returns null for a run that does not form a group', () => {
        const call = claudeAssistant([{ type: 'tool_use', id: 'e', name: 'Read', input: {} }])
        expect(collectToolGroupDescriptors([call, claudeToolResult('e')])).toBeNull()
    })

    it('refuses to compact a run holding a subagent call', () => {
        const task = claudeAssistant([{ type: 'tool_use', id: 'x', name: 'Task', input: { prompt: 'go' } }])
        const read = claudeAssistant([{ type: 'tool_use', id: 'y', name: 'Read', input: {} }])
        expect(collectToolGroupDescriptors([task, read])).toBeNull()
    })

    it('sums the token usage of the messages it replaces', () => {
        const withUsage = (id: string, input: number, output: number) => message({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: {
                        id: `api-${id}`,
                        model: 'claude-test',
                        content: [{ type: 'tool_use', id, name: 'Read', input: {} }],
                        usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 5 }
                    }
                }
            }
        })

        const collected = collectToolGroupDescriptors([withUsage('u1', 10, 3), withUsage('u2', 20, 4)])

        expect(collected!.usage).toEqual({
            input_tokens: 30,
            output_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10
        })
        expect(collected!.model).toBe('claude-test')
    })
})

describe('truncateToolInput', () => {
    it('keeps short display fields and shortens bulky payloads', () => {
        const input = { file_path: '/a.ts', content: 'x'.repeat(5_000) }
        const truncated = truncateToolInput(input) as { file_path: string; content: string }
        expect(truncated.file_path).toBe('/a.ts')
        expect(truncated.content.length).toBeLessThan(700)
        expect(truncated.content.endsWith('…')).toBe(true)
    })

    it('caps arrays and drops content past the depth limit', () => {
        const truncated = truncateToolInput({ items: Array.from({ length: 100 }, (_, i) => i) }) as { items: number[] }
        expect(truncated.items).toHaveLength(20)

        const deep = truncateToolInput({ a: { b: { c: { d: { e: { f: 1 } } } } } }) as Record<string, unknown>
        expect(JSON.stringify(deep)).toBe('{"a":{"b":{"c":{"d":{}}}}}')
    })
})

describe('getToolGroupSpan', () => {
    it('reads the span from a compacted group envelope', () => {
        expect(getToolGroupSpan({
            role: 'agent',
            content: { type: 'tool-group', groupId: 'tool-group:a', firstSeq: 4, lastSeq: 9, tools: [] }
        })).toEqual({ firstSeq: 4, lastSeq: 9 })
    })

    it('returns null for anything else', () => {
        expect(getToolGroupSpan({ role: 'user', content: { type: 'text', text: 'hi' } })).toBeNull()
        expect(getToolGroupSpan(null)).toBeNull()
    })
})
