import type { SyncEngine } from './syncEngine'
import { extractAssistantText } from './assistantText'
import { messageEventType } from '../notifications/eventParsing'

const REPLY_MAX_CHARS = 3000
/** Recent conversation handed to the voice model so it hears the project's names and terms right. */
const CONTEXT_MAX_CHARS = 1500

/** What a voice reads: code, tables and links collapsed into a spoken placeholder. */
export function speakable(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, '（一段代码）')
        .replace(/(?:^\|.*\|[ \t]*(?:\n|$))+/gm, '（一张表）\n')
        .replace(/https?:\/\/\S+/g, '（链接）')
        .replace(/`([^`\n]+)`/g, '$1')
        .trim()
        .slice(-REPLY_MAX_CHARS)
}

/**
 * The agent's reply to the turn that followed `afterSeq`, or null while that turn still runs. Only the agent's
 * own words count (tool calls and results are left out), taken from the newest messages: a long turn has far
 * more tool calls than words, and its answer comes last.
 */
export function turnReply(engine: SyncEngine, sessionId: string, afterSeq: number): string | null {
    const messages = engine.getSessionHistory(sessionId, { afterSeq, tail: 200, limit: 200 }).messages
    if (!messages.some((message) => messageEventType(message.content) === 'ready')) return null
    return speakable(messages
        .filter((message) => message.role === 'assistant')
        .map((message) => extractAssistantText(message.content))
        .filter(Boolean)
        .join('\n\n'))
}

/** The session's latest exchanges as plain lines, for the voice model's context and transcription corpus. */
export function recentConversation(engine: SyncEngine, sessionId: string): string {
    const lines = engine.getSessionHistory(sessionId, { tail: 30, limit: 30 }).messages.flatMap((message) => {
        const text = message.role === 'user' ? message.text : message.role === 'assistant' ? extractAssistantText(message.content) : null
        return text?.trim() ? [`${message.role === 'user' ? '用户' : 'Claude'}：${text.trim().replace(/\s+/g, ' ').slice(0, 400)}`] : []
    })
    return lines.join('\n').slice(-CONTEXT_MAX_CHARS)
}
