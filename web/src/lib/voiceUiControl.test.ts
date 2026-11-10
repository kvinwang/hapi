import { describe, expect, it } from 'vitest'
import { spokenUiControl, voiceUiControlSchema } from './voiceUiControl'

describe('voice UI controls', () => {
    it('recognizes standalone commands and Chinese list numbers', () => {
        expect(spokenUiControl('切换会话。', false)).toEqual({ action: 'list_sessions' })
        expect(spokenUiControl('选第二个', true)).toEqual({ action: 'select_session', index: 2 })
        expect(spokenUiControl('关闭草稿', false)).toEqual({ action: 'draft_panel', open: false })
        expect(spokenUiControl('打开朗读', false)).toEqual({ action: 'readback', enabled: true })
    })
    it.each(['第二个', '请把“关闭草稿”发给 AI', '切换会话功能有问题', '他说打开朗读', '“打开草稿”'])('does not intercept draft content: %s', text => {
        expect(spokenUiControl(text, false)).toBeNull()
    })
    it('validates required arguments and rejects invalid selection indexes', () => {
        expect(voiceUiControlSchema.safeParse({ action: 'readback' }).success).toBe(false)
        expect(voiceUiControlSchema.safeParse({ action: 'select_session', index: 0 }).success).toBe(false)
    })
})

it.each([
    ['草稿自动发送', { action: 'auto_send', enabled: true }],
    ['草稿不要自动发送', { action: 'auto_send', enabled: false }],
    ['等五秒钟自动发送', { action: 'auto_send', enabled: true, delay: 5 }],
    ['停顿十二秒后自动发送', { action: 'auto_send', enabled: true, delay: 12 }],
    ['等30秒自动发送', { action: 'auto_send', enabled: true, delay: 30 }]
])('changes auto-send settings for %s', (text, expected) => {
    expect(spokenUiControl(text as string, false)).toEqual(expected)
})
it.each(['等等', '编辑一下', '他说草稿自动发送', '自动发送功能有问题', '等99秒自动发送'])('does not change preferences for %s', text => {
    expect(spokenUiControl(text, false)).toBeNull()
})


it.each(['清空语音历史', '清空所有语音历史', '清空候选列表', '语音重新开始'])('resets voice editing state for %s', text => {
    expect(spokenUiControl(text, false)).toEqual({ action: 'reset_voice' })
})
it.each(['他说清空语音历史', '把清空候选列表这句话发给AI', '“清空语音历史”'])('keeps quoted reset requests as content: %s', text => {
    expect(spokenUiControl(text, false)).toBeNull()
})

it.each(['切换到麦克风', '切到麦克风那个会话', '切换到麦克风的会话。'])('leaves title selection to the model: %s', text => {
    expect(spokenUiControl(text, false)).toBeNull()
})
it.each(['他说切换到麦克风', '把切换到麦克风这句话发给 AI', '“切换到麦克风”', '切换到第二个'])('does not treat quoted commands or bare list numbers as title keywords: %s', text => {
    expect(spokenUiControl(text, false)).toBeNull()
})


it.each(['停止朗读', '别读了', '暂停朗读'])('interrupts ongoing speech for %s', text => {
    expect(spokenUiControl(text, false)).toEqual({ action: 'stop_readback' })
})

it.each([
    ['以后用中文播报', 'zh'],
    ['切换成英文播报', 'en'],
    ['用中文朗读', 'zh'],
    ['read aloud in English', 'en']
])('changes the saved readback language for %s', (text, language) => {
    expect(spokenUiControl(text, false)).toEqual({ action: 'readback_language', language })
    expect(voiceUiControlSchema.safeParse({ action: 'readback_language', language }).success).toBe(true)
})
it.each(['把“用中文播报”发给AI', '他说切换成英文播报', '“以后用中文播报”'])('does not interpret quoted language settings as controls: %s', text => {
    expect(spokenUiControl(text, false)).toBeNull()
})

it.each([
    ['第十二个', 12], ['选择第20个会话', 20], ['select the second session', 2], ['session 12', 12], ['choose 6', 6],
])('selects the displayed badge number for %s', (text, index) => {
    expect(spokenUiControl(text as string, true)).toEqual({ action: 'select_session', index })
    expect(spokenUiControl(text as string, false)).toBeNull()
})


it('opens and cancels the native selection panel for standalone English requests', () => {
    expect(spokenUiControl('Switch session.', false)).toEqual({ action: 'list_sessions' })
    expect(spokenUiControl('Cancel selection', true)).toEqual({ action: 'cancel_selection' })
    expect(spokenUiControl('When I say switch session, show the list.', false)).toBeNull()
})

it.each(['朗读当前对话最后的内容', '播报一下最后的内容', '把最新回复读一下', '念一下刚才的回复', '朗读最新回复', 'Read the last reply.'])('replays the latest reply for %s', text => {
    expect(spokenUiControl(text, false)).toEqual({ action: 'replay_readback' })
})
it.each(['读一下最新的代码', '他说朗读最新回复', '最后的内容有问题', '朗读功能最后再改'])('keeps other read requests as content: %s', text => {
    expect(spokenUiControl(text, false)).toBeNull()
})
