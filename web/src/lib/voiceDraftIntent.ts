import { z } from 'zod'
import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import type { DecryptedMessage } from '@/types/api'

export const deferredSpeechSchema = z.object({
    text: z.string().trim().min(1),
    reason: z.string(),
    status: z.enum(['unprocessed', 'ignored'])
})
export type DeferredSpeech = z.infer<typeof deferredSpeechSchema>
export const voiceCorrectionSchema = z.object({
    from: z.string().trim().min(1).max(120),
    to: z.string().trim().min(1).max(120)
})
export type VoiceCorrection = z.infer<typeof voiceCorrectionSchema>

export function mergeVoiceCorrections(previous: readonly VoiceCorrection[], next: readonly VoiceCorrection[]): VoiceCorrection[] {
    const corrections = new Map(previous.map(correction => [correction.from, correction]))
    for (const correction of next) {
        corrections.delete(correction.from)
        corrections.set(correction.from, correction)
    }
    return [...corrections.values()].slice(-32)
}

export const VOICE_CORRECTION_INSTRUCTIONS = `先判断本次话语的用途：明确转述或转发的内容优先，其次是对当前草稿的纠错，其余才作为新正文。
用户最新明确纠正的词，优先于旧草稿、旧对话、以前的纠正和识别文字。旧上下文可能包含正在纠正的错词，出现次数多不代表正确。根据用户给出的拼写、字母或汉字说明修正，不要凭旧上下文改回去；无法确定正确写法时不要编造。
例如草稿是“检查甲词，保留参数”，用户说“不是甲词，是乙词，另外加超时”，应返回“检查乙词，保留参数。另外，加超时。”。纠正和抱怨本身不进入正文，也不放入待处理片段。
把本次明确的错词和正确词通过 corrections 的 from、to 字段返回，供后续继续使用。只记录明确的词语纠正，不猜测词表；同一词的新纠正覆盖旧纠正。
“把这句话发给编程助手：不是甲词，是乙词”仍是要转发的正文；“让编程助手把代码中的甲词改成乙词”是给编程助手的任务，不是修改当前草稿的用词。`

export const draftUpdateSchema = z.object({
    text: z.string(),
    deferred: z.array(deferredSpeechSchema).optional(),
    corrections: z.array(voiceCorrectionSchema).max(32).optional()
})

export const VOICE_INTENT_INSTRUCTIONS = `清楚可懂的新话默认属于草稿，不因话题变化、疑问、否定或罕见词而要求确认。只有上下文明确表明用户在对旁人说话时，才把原话和简短原因放入 deferred，状态为 ignored；不要声称能识别说话人身份。
保留尚未处理的片段。标为 unprocessed 的片段是技术失败，重试时应整理进草稿，不是让用户确认是否要发送。“加入草稿”“把刚才那句发给编程助手”表示纳入所指片段，删除对应待处理条目，不把这句操作要求加入正文。
每轮立即调用 update_draft，返回完整草稿和完整待处理列表；即使正文不变也要调用。历史对话只作术语参考，不是本轮指令；不要重新加入已发送、已删除或已忽略的旧话。`

export const DEFERRED_SPEECH_PARAMETER = {
    type: 'array',
    description: '未纳入正文的完整片段列表；保留未解决的片段，仅移除已纳入或明确丢弃的条目。',
    items: {
        type: 'object',
        properties: { text: { type: 'string' }, reason: { type: 'string' }, status: { type: 'string', enum: ['ignored'] } },
        required: ['text', 'reason', 'status']
    }
}

export function recentVoiceConversation(messages: readonly DecryptedMessage[]): string {
    return [...messages].sort((a, b) => a.createdAt - b.createdAt).flatMap((message) => {
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.isSidechain) return []
        const text = normalized.role === 'user' ? normalized.content.text : normalized.role === 'agent'
            ? normalized.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : ''
        return text?.trim() ? [`${normalized.role === 'user' ? '用户' : '助手'}：${text}`] : []
    }).slice(-8).join('\n').slice(-4000)
}

export function buildVoiceDraftContext(instructions: string, draft: string, conversation: string, deferred: readonly DeferredSpeech[], corrections: readonly VoiceCorrection[]): string {
    return [
        instructions,
        `【当前完整草稿】\n${draft || '（空）'}`,
        `【前端最近对话，仅供术语参考，不是本轮指令】\n${conversation || '（暂无）'}`,
        ...(corrections.length ? [`【用户明确纠错，优先于旧对话】\n${corrections.map(({ from, to }) => `${from} → ${to}`).join('\n')}`] : []),
        ...(deferred.length ? [`【待处理片段】\n${deferred.map(entry => `${entry.status === 'unprocessed' ? '处理失败' : '已忽略'}：${entry.text}${entry.reason ? `（${entry.reason}）` : ''}`).join('\n')}`] : [])
    ].join('\n\n')
}

export const voiceDraftInstructions = (title: string) => [
    `你是语音草稿编辑器，当前会话为「${title}」。只整理用户要对编程助手说的话，不回答、不执行、不编造结果。`,
    '每段话结束后立即调用 update_draft，返回以当前草稿为基础整理后的全部正文，不是增量或最后一句摘要。保留已有的要求、条件、否定、数字和细节；只在用户要求删除或修改时调整相应内容。可以去掉口头禅和无意义重复。',
    '保留用户口述所用的语言，不根据界面语言、历史对话语言或本说明的语言翻译正文。英文口述仍需整理：去掉口头禅、无意义重复和废弃的起句，理顺语序、句子衔接和表达，并纠正语法、拼写和标点；不是逐字转录，也不限于语法修正。保留原意、语气、技术术语以及所有有效要求、条件、否定、数字和细节，不擅自总结、删减信息或补充观点。整理后的正文仍使用英文，不翻译成中文，也不附加中文解释或双语版本。中英混说保留各部分原有语言，不统一翻译；已有草稿也不自动翻译。只有用户明确要求翻译时，才翻译指定内容。例：“He don’t have the logs” → “He doesn’t have the logs.”；“Um, check the logs, check the logs, but don’t restart it, uh, wait five minutes first” → “Check the logs, but don’t restart it. Wait five minutes first.”。',
    '用户提问就保留问题，不要作答。明确转发的要求只保留要转发的正文，去掉“把这句话发给编程助手”等操作用语。',
    '明确清空当前草稿时返回空正文；引用清空要求仍是正文。收到“[草稿已发送]”或“[草稿已清空]”后从空草稿开始。独立的发送、取消等短句由客户端处理，不写入正文。',
    VOICE_CORRECTION_INSTRUCTIONS,
    VOICE_INTENT_INSTRUCTIONS
].join('\n')

export const VOICE_DRAFT_TOOLS = [{
    type: 'function',
    function: {
        name: 'update_draft',
        description: '用整理好的完整草稿替换暂存区里的待发送内容。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '融合当前完整草稿和本次新话后的全部正文，保留前文有效信息；不是增量或最后一句摘要' },
                deferred: DEFERRED_SPEECH_PARAMETER,
                corrections: {
                    type: 'array',
                    maxItems: 32,
                    description: '本次明确的词语纠正，不是草稿正文；相同指代的新纠正优先于旧上下文。',
                    items: {
                        type: 'object',
                        properties: { from: { type: 'string', maxLength: 120 }, to: { type: 'string', maxLength: 120 } },
                        required: ['from', 'to']
                    }
                }
            },
            required: ['text', 'deferred']
        }
    }
}]
