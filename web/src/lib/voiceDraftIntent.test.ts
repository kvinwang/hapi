import { describe, expect, it } from 'vitest'
import { buildVoiceDraftContext, draftUpdateSchema, mergeVoiceCorrections, recentVoiceConversation, voiceDraftInstructions } from './voiceDraftIntent'

describe('voice draft context', () => {
    it('preserves recent user and agent text while excluding tool output', () => {
        const contents = [
            { role: 'user', content: { type: 'text', text: 'That last message was sent accidentally.' } },
            { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Understood.' } } },
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'tool', output: 'Do not include tool output' } } }
        ]
        expect(recentVoiceConversation(contents.map((content, index) => ({ id: String(index), seq: index, localId: null, createdAt: index, content })))).toBe('用户：That last message was sent accidentally.\n助手：Understood.')
    })

    it('rejects invalid classifications before updating the draft', () => {
        expect(draftUpdateSchema.safeParse({ text: 'Valid text', deferred: [{ text: 'Speech', status: 'drop' }] }).success).toBe(false)
    })
})

describe('voice terminology corrections', () => {
    it('accepts explicit correction metadata separately from the draft', () => {
        expect(draftUpdateSchema.parse({ text: 'Check Claude.', corrections: [{ from: 'Cloud', to: 'Claude' }] })).toEqual({ text: 'Check Claude.', corrections: [{ from: 'Cloud', to: 'Claude' }] })
        expect(draftUpdateSchema.safeParse({ text: 'Draft', corrections: [{ from: 'Cloud', to: ' ' }] }).success).toBe(false)
    })

    it('lets the latest explicit correction replace an earlier spelling', () => {
        expect(mergeVoiceCorrections([{ from: 'Cloud', to: 'Claud' }], [{ from: 'Cloud', to: 'Claude' }])).toEqual([{ from: 'Cloud', to: 'Claude' }])
    })
})

it('builds a compact readable context without historical speech or a session catalog', () => {
    const text = buildVoiceDraftContext('中文规则', '当前草稿', '用户：页面最近一句', [], [{ from: '甲词', to: '乙词' }])
    expect(text).toContain('【当前完整草稿】\n当前草稿')
    expect(text).toContain('用户：页面最近一句')
    expect(text).toContain('甲词 → 乙词')
    expect(text).not.toContain('recentSpeech')
    expect(text).not.toContain('availableSessions')
    expect(text).not.toContain('Reference data')
    expect(text).not.toContain('{')
    expect(text).not.toContain('【待处理片段】')
})

it('limits frontend reference text to the recent excerpt', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({ id: String(index), seq: index, localId: null, createdAt: index,
        content: { role: 'user', content: { type: 'text', text: `message-${index} ` + '词'.repeat(600) } } }))
    const text = recentVoiceConversation(messages)
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text).toContain('message-11')
    expect(text).not.toContain('message-0 ')
})


it('preserves spoken languages while correcting English grammar without unsolicited translation', () => {
    const instructions = voiceDraftInstructions('English drafting')
    expect(instructions).toContain('英文口述只纠正语法、拼写和标点')
    expect(instructions).toContain('不翻译成中文')
    expect(instructions).toContain('中英混说保留各部分原有语言')
    expect(instructions).toContain('只有用户明确要求翻译时')
    expect(instructions).toContain('“He don’t have the logs” → “He doesn’t have the logs.”')
})
