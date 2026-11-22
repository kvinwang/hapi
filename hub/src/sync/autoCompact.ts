import type { Session } from '@hapi/protocol/types'

/** Compact just before the 1 h prompt cache expires: later, the compaction itself reads the whole context uncached. */
export const AUTO_COMPACT_IDLE_MS = 55 * 60_000
const AUTO_COMPACT_WINDOW_MS = 5 * 60_000
export const AUTO_COMPACT_DEFAULT_MIN_TOKENS = 50_000
export const AUTO_COMPACT_PREFERENCE = 'autoCompactMinTokens'

/** The stored preference: 'off', or the minimum used context in tokens (absent: the default). */
export function autoCompactMinTokens(value: string | null): number | null {
    if (value === 'off') return null
    const tokens = value === null ? NaN : Number(value)
    return Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : AUTO_COMPACT_DEFAULT_MIN_TOKENS
}

function messageText(content: unknown): string {
    const text = (content as { content?: { text?: unknown } } | null)?.content?.text
    return typeof text === 'string' ? text.trim() : ''
}

export function shouldAutoCompact(
    session: Session,
    minTokens: number | null,
    lastMessage: { createdAt: number } | undefined,
    lastUserMessage: { content: unknown } | undefined,
    now: number
): boolean {
    if (minTokens === null || !session.active || session.thinking) return false
    if (session.metadata?.flavor !== 'claude' || session.agentState?.controlledByUser) return false
    if (Object.keys(session.agentState?.requests ?? {}).length > 0) return false
    if ((session.metadata.contextTokens ?? 0) < minTokens) return false
    if (!lastMessage || !lastUserMessage) return false
    const idle = now - lastMessage.createdAt
    if (idle < AUTO_COMPACT_IDLE_MS || idle >= AUTO_COMPACT_IDLE_MS + AUTO_COMPACT_WINDOW_MS) return false
    return !messageText(lastUserMessage.content).startsWith('/compact')
}
