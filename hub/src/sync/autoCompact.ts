import type { Session } from '@hapi/protocol/types'
import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import type { StoredMessage } from '../store'

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

/** CLIs older than the `get_context_usage` report leave `metadata.contextTokens` unset: read the latest turn's usage instead. */
function contextTokens(session: Session, recent: readonly StoredMessage[]): number {
    if (session.metadata?.contextTokens !== undefined) return session.metadata.contextTokens
    for (const message of [...recent].reverse()) {
        const usage = normalizeDecryptedMessage(message)?.usage
        // Turn summaries carry only session totals, with zero per-request input.
        const tokens = usage && (usage.context_tokens ?? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0))
        if (tokens) return tokens
    }
    return 0
}

/** `recent`: the latest messages, oldest first. */
export function shouldAutoCompact(
    session: Session,
    minTokens: number | null,
    recent: readonly StoredMessage[],
    lastUserMessage: { content: unknown } | undefined,
    now: number
): boolean {
    if (minTokens === null || !session.active || session.thinking) return false
    if (session.metadata?.flavor !== 'claude' || session.agentState?.controlledByUser) return false
    if (Object.keys(session.agentState?.requests ?? {}).length > 0) return false
    const lastMessage = recent.at(-1)
    if (!lastMessage || !lastUserMessage || contextTokens(session, recent) < minTokens) return false
    const idle = now - lastMessage.createdAt
    if (idle < AUTO_COMPACT_IDLE_MS || idle >= AUTO_COMPACT_IDLE_MS + AUTO_COMPACT_WINDOW_MS) return false
    return !messageText(lastUserMessage.content).startsWith('/compact')
}
