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
        expect(voiceUiControlSchema.safeParse({ action: 'select_session', index: 6 }).success).toBe(false)
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
