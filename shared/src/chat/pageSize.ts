/**
 * How much of a session one history request carries.
 *
 * With `toolGroups=1` the unit is blocks the reader sees, not stored rows: a
 * page of 20 can stand for a thousand tool messages. The hub and the web client
 * share the default so a client that omits `limit` gets the same page as one
 * that sends it.
 */
export const DEFAULT_CHAT_PAGE_SIZE = 20

/** Sizes offered in settings. The hub accepts anything from 1 to 200. */
export const CHAT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const

export type ChatPageSize = (typeof CHAT_PAGE_SIZE_OPTIONS)[number]

export function isChatPageSize(value: unknown): value is ChatPageSize {
    return CHAT_PAGE_SIZE_OPTIONS.includes(value as ChatPageSize)
}
