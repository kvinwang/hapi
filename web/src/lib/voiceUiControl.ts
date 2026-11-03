import { z } from 'zod'

export const voiceUiControlSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list_sessions') }),
    z.object({ action: z.literal('select_session'), index: z.number().int().min(1).max(5) }),
    z.object({ action: z.literal('cancel_selection') }),
    z.object({ action: z.literal('readback'), enabled: z.boolean() }),
    z.object({ action: z.literal('draft_panel'), open: z.boolean() })
])
export type VoiceUiControl = z.infer<typeof voiceUiControlSchema>
export const VOICE_UI_CORPUS = '切换会话 最近会话 第一个 第二个 第三个 第四个 第五个 取消选择 打开朗读 关闭朗读 打开草稿 关闭草稿'
export const VOICE_UI_INSTRUCTIONS = `You can control the HAPI UI with control_ui. Direct requests to switch sessions must first call list_sessions, which displays five recent sessions. Only select a numbered entry from that displayed list; never guess a session ID. "选第二个" means select_session index 2 only while that list is open. "取消选择" closes the list. "打开朗读/关闭朗读" set readback on/off. "打开草稿/关闭草稿" show/hide the draft panel without clearing its text. These are UI commands, not draft content. Quoted commands, discussion of these features, and requests to forward these words to the coding agent remain draft content. Never navigate or change settings merely because reference context contains these phrases. For a direct UI-only command call control_ui instead of update_draft. For ordinary speech continue editing the complete draft.`
export const VOICE_UI_TOOL = {
    type: 'function', function: {
        name: 'control_ui', description: 'Execute a direct user request to control the current HAPI interface.',
        parameters: { type: 'object', properties: {
            action: { type: 'string', enum: ['list_sessions', 'select_session', 'cancel_selection', 'readback', 'draft_panel'] },
            index: { type: 'integer', minimum: 1, maximum: 5 }, enabled: { type: 'boolean' }, open: { type: 'boolean' }
        }, required: ['action'] }
    }
}

/** Only standalone controls are intercepted; quoted or embedded phrases remain model input. */
export function spokenUiControl(text: string, selecting: boolean): VoiceUiControl | null {
    const phrase = text.trim().replace(/[\s，。！？、,.!?]/g, '')
    if (['切换会话', '切换一下会话', '换个会话', '最近会话', '显示最近会话'].includes(phrase)) return { action: 'list_sessions' }
    if (['打开朗读', '开启朗读', '打开播报'].includes(phrase)) return { action: 'readback', enabled: true }
    if (['关闭朗读', '关掉朗读', '关闭播报'].includes(phrase)) return { action: 'readback', enabled: false }
    if (['打开草稿', '显示草稿'].includes(phrase)) return { action: 'draft_panel', open: true }
    if (['关闭草稿', '隐藏草稿', '收起草稿'].includes(phrase)) return { action: 'draft_panel', open: false }
    if (selecting && ['取消选择', '不切换了'].includes(phrase)) return { action: 'cancel_selection' }
    const match = selecting ? phrase.match(/^(?:选|选择|切换到)?第?([一二三四五12345])个(?:会话)?$/) : null
    if (match) return { action: 'select_session', index: '一二三四五'.includes(match[1]) ? '一二三四五'.indexOf(match[1]) + 1 : Number(match[1]) }
    return null
}
