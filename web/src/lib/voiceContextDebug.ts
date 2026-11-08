import type { OmniEvent } from './omniTransport'

/** Only model-facing text is retained: never transport options, credentials, or audio payloads. */
export class VoiceContextDebug {
    private instructions = ''
    private tools: unknown[] = []
    private textEvents: unknown[] = []

    constructor(private readonly sessionId: string) {}

    record(event: OmniEvent): void {
        if (event.type === 'session.update') {
            const session = event.session as { instructions?: unknown; tools?: unknown } | undefined
            if (typeof session?.instructions === 'string') this.instructions = session.instructions
            if (Array.isArray(session?.tools)) this.tools = session.tools
        } else if (event.type === 'conversation.item.create') {
            const item = event.item as { type?: string; id?: string; role?: string; call_id?: string; output?: string; content?: Array<{ type?: string; text?: string }> } | undefined
            if (item?.type === 'message') {
                const content = item.content?.filter(part => typeof part.text === 'string').map(part => ({ type: part.type, text: part.text })) ?? []
                if (content.length) this.textEvents.push({ type: event.type, item: { type: item.type, id: item.id, role: item.role, content } })
            } else if (item?.type === 'function_call_output' && typeof item.output === 'string') {
                this.textEvents.push({ type: event.type, item: { type: item.type, call_id: item.call_id, output: item.output } })
            }
        } else if (event.type === 'conversation.item.delete' && typeof event.item_id === 'string') {
            this.textEvents.push({ type: event.type, item_id: event.item_id })
        }
    }

    snapshot(): string {
        return [`会话：${this.sessionId}`, '=== 最新系统提示词原文 ===', this.instructions, '=== 工具定义 ===', JSON.stringify(this.tools, null, 2), '=== 本次连接发送的文字事件 ===', JSON.stringify(this.textEvents, null, 2)].join('\n\n')
    }
}
