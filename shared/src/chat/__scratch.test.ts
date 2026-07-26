import { describe, it } from 'vitest'
import type { ChatSourceMessage } from './types'
import { compactToolRuns } from './toolRunPage'
import { classifyToolRunMessage } from './toolRun'

let nextSeq = 0
function message(content: unknown): ChatSourceMessage {
    nextSeq += 1
    return { id: `m${nextSeq}`, seq: nextSeq, localId: null, createdAt: 1_000 + nextSeq, content }
}
function claudeAssistant(blocks: unknown[]): ChatSourceMessage {
    return message({ role: 'agent', content: { type: 'output', data: { type: 'assistant', message: { content: blocks } } } })
}
function claudeToolResult(toolUseId: string): ChatSourceMessage {
    return message({ role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'BODY-' + toolUseId }] } } } })
}
function codexTokenCount(total: number): ChatSourceMessage {
    return message({ role: 'agent', content: { type: 'codex', data: { type: 'token_count', info: { last: { input_tokens: 5, output_tokens: 1, total_tokens: 6 }, total: { input_tokens: total, output_tokens: 2, total_tokens: total + 2 } } } } })
}

describe('transparent inside run', () => {
    it('keeps usage-only + reasoning messages inside the compacted span', () => {
        const c1 = claudeAssistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])
        const r1 = claudeToolResult('t1')
        const tok = codexTokenCount(500)
        const think = claudeAssistant([{ type: 'thinking', thinking: 'hmm' }])
        const c2 = claudeAssistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }])
        const r2 = claudeToolResult('t2')
        const all = [c1, r1, tok, think, c2, r2]
        console.log('kinds', all.map(classifyToolRunMessage))
        const out = compactToolRuns(all, { sessionMaxSeq: 10_000 })
        console.log('OUT ids/seqs', out.map(m => [m.id, m.seq, (m.content as any).content.type]))
        console.log('span', JSON.stringify((out[0].content as any).content.firstSeq), (out[0].content as any).content.lastSeq)
    })
})
