import { z } from 'zod'

export const voiceUiControlSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('list_sessions') }),
    z.object({ action: z.literal('reset_voice') }),
    z.object({ action: z.literal('select_session'), index: z.number().int().min(1).max(5) }),
    z.object({ action: z.literal('cancel_selection') }),
    z.object({ action: z.literal('readback'), enabled: z.boolean() }),
    z.object({ action: z.literal('auto_send'), enabled: z.boolean().optional(), delay: z.number().int().min(1).max(60).optional() }).refine(value => value.enabled !== undefined || value.delay !== undefined),
    z.object({ action: z.literal('draft_panel'), open: z.boolean() })
])
export type VoiceUiControl = z.infer<typeof voiceUiControlSchema>
export const VOICE_UI_CORPUS = '切换会话 最近会话 第一个 第二个 第三个 第四个 第五个 取消选择 打开朗读 关闭朗读 打开草稿 关闭草稿 草稿自动发送 草稿不要自动发送 两秒 三秒 五秒 十秒后自动发送 清空语音历史 清空所有语音历史 清空候选列表 语音重新开始'
export const VOICE_UI_INSTRUCTIONS = `You can control the HAPI UI with control_ui. Direct requests to switch sessions must first call list_sessions, which displays five recent sessions. Only select a numbered entry from that displayed list; never guess a session ID. "选第二个" means select_session index 2 only while that list is open. "取消选择" closes the list. "打开朗读/关闭朗读" set readback on/off. "打开草稿/关闭草稿" show/hide the draft panel without clearing its text. "草稿自动发送/草稿不要自动发送" set auto_send.enabled true/false persistently. "等五秒钟自动发送" sets auto_send enabled=true, delay=5 (integer seconds 1–60). "延迟改成十秒" changes only delay. Unsupported durations must not be silently rounded. "等等/编辑一下" are temporary pause commands, not changes to the saved preference. "清空语音历史/清空所有语音历史/清空候选列表/语音重新开始" call reset_voice: clear all local voice drafts, deferred candidates, speech and editing context across sessions, but NEVER delete the coding-agent chat history. Direct requests to clear all voice history or candidate lists are controls; quoted requests remain content. These are UI commands, not draft content. Quoted commands, discussion of these features, and requests to forward these words to the coding agent remain draft content. Never navigate or change settings merely because reference context contains these phrases. For a direct UI-only command call control_ui instead of update_draft. For ordinary speech continue editing the complete draft.`
export const VOICE_UI_TOOL = {
    type: 'function', function: {
        name: 'control_ui', description: 'Execute a direct user request to control the current HAPI interface.',
        parameters: { type: 'object', properties: {
            action: { type: 'string', enum: ['list_sessions', 'select_session', 'cancel_selection', 'readback', 'draft_panel', 'auto_send', 'reset_voice'] },
            index: { type: 'integer', minimum: 1, maximum: 5 }, enabled: { type: 'boolean' }, delay: { type: 'integer', minimum: 1, maximum: 60 }, open: { type: 'boolean' }
        }, required: ['action'] }
    }
}

/** Only standalone controls are intercepted; quoted or embedded phrases remain model input. */
export function spokenUiControl(text: string, selecting: boolean): VoiceUiControl | null {
    const phrase = text.trim().replace(/[\s，。！？、,.!?]/g, '')
    if (['清空语音历史', '清空所有语音历史', '清空候选列表', '清空候选', '清掉候选列表', '清空所有会话历史', '清空所有候选', '语音重新开始', '重置语音草稿'].includes(phrase)) return { action: 'reset_voice' }
    if (['切换会话', '切换一下会话', '换个会话', '最近会话', '显示最近会话'].includes(phrase)) return { action: 'list_sessions' }
    if (['打开朗读', '开启朗读', '打开播报'].includes(phrase)) return { action: 'readback', enabled: true }
    if (['关闭朗读', '关掉朗读', '关闭播报'].includes(phrase)) return { action: 'readback', enabled: false }
    if (['打开草稿', '显示草稿'].includes(phrase)) return { action: 'draft_panel', open: true }
    if (['关闭草稿', '隐藏草稿', '收起草稿'].includes(phrase)) return { action: 'draft_panel', open: false }
    if (['草稿自动发送', '开启自动发送', '打开自动发送', '草稿开启自动发送'].includes(phrase)) return { action: 'auto_send', enabled: true }
    if (['草稿不要自动发送', '草稿不自动发送', '关闭自动发送', '取消自动发送', '不要自动发送'].includes(phrase)) return { action: 'auto_send', enabled: false }
    const timing = phrase.match(/^(?:草稿)?(?:等|等待|停顿|停止说话后)?([一二两三四五六七八九十\d]+)秒(?:钟)?(?:后)?自动发送$/)
    if (timing) {
        const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
        const parts = timing[1].split('十')
        const delay = /^\d+$/.test(timing[1]) ? Number(timing[1]) : parts.length === 2 ? (digits[parts[0]] ?? 1) * 10 + (digits[parts[1]] ?? 0) : digits[timing[1]]
        if (Number.isInteger(delay) && delay >= 1 && delay <= 60) return { action: 'auto_send', enabled: true, delay }
    }
    if (selecting && ['取消选择', '不切换了'].includes(phrase)) return { action: 'cancel_selection' }
    const match = selecting ? phrase.match(/^(?:选|选择|切换到)?第?([一二三四五12345])个(?:会话)?$/) : null
    if (match) return { action: 'select_session', index: '一二三四五'.includes(match[1]) ? '一二三四五'.indexOf(match[1]) + 1 : Number(match[1]) }
    return null
}
