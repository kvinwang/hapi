import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { isUserMessage, mergeMessages } from '@/lib/messages'

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    pending: DecryptedMessage[]
    pendingCount: number
    hasMore: boolean
    hasNewer: boolean
    oldestSeq: number | null
    newestSeq: number | null
    isLoading: boolean
    isLoadingMore: boolean
    isLoadingNewer: boolean
    warning: string | null
    atBottom: boolean
    messagesVersion: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const PENDING_WINDOW_SIZE = 200
const PAGE_SIZE = 50
const RECONNECT_PAGE_SIZE = 200
const NEWER_BATCH_MAX_PAGES = 6
/** When Load older yields only tool activity, keep fetching until text or this cap. */
const OLDER_SKIP_TOOL_ONLY_MAX_PAGES = 20
const FOCUS_WINDOW_BEFORE = 160
const FOCUS_WINDOW_AFTER = 160
const PENDING_OVERFLOW_WARNING = 'New messages arrived while you were away. Scroll to bottom to refresh.'

type InternalState = MessageWindowState & {
    historyRequestGeneration: number
    pendingOverflowCount: number
    pendingVisibleCount: number
    pendingOverflowVisibleCount: number
    latestPageCache: DecryptedMessage[]
    latestPageHasMore: boolean
}

type PendingVisibilityCacheEntry = {
    source: DecryptedMessage
    visible: boolean
}

type TrimResult = {
    visible: DecryptedMessage[]
    droppedOlder: number
    droppedNewer: number
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const pendingVisibilityCacheBySession = new Map<string, Map<string, PendingVisibilityCacheEntry>>()

// Throttled notification: coalesce rapid state updates into at most one
// notification per NOTIFY_THROTTLE_MS during streaming. This prevents
// Windows UI jank caused by excessive React re-renders during SSE streaming.
const NOTIFY_THROTTLE_MS = 150
const pendingNotifySessionIds = new Set<string>()
let notifyRafId: ReturnType<typeof requestAnimationFrame> | null = null
let notifyTimeoutId: ReturnType<typeof setTimeout> | null = null
let lastNotifyAt = 0

function scheduleNotify(sessionId: string): void {
    pendingNotifySessionIds.add(sessionId)
    if (notifyRafId !== null || notifyTimeoutId !== null) {
        return
    }
    const elapsed = Date.now() - lastNotifyAt
    if (elapsed >= NOTIFY_THROTTLE_MS) {
        // Enough time has passed — flush on next animation frame
        notifyRafId = requestAnimationFrame(flushNotifications)
    } else {
        // Too soon — delay until the throttle window expires, then use rAF
        const remaining = NOTIFY_THROTTLE_MS - elapsed
        notifyTimeoutId = setTimeout(() => {
            notifyTimeoutId = null
            notifyRafId = requestAnimationFrame(flushNotifications)
        }, remaining)
    }
}

function flushNotifications(): void {
    notifyRafId = null
    lastNotifyAt = Date.now()
    const sessionIds = Array.from(pendingNotifySessionIds)
    pendingNotifySessionIds.clear()
    for (const sessionId of sessionIds) {
        const subs = listeners.get(sessionId)
        if (!subs) continue
        for (const listener of subs) {
            listener()
        }
    }
}

function getPendingVisibilityCache(sessionId: string): Map<string, PendingVisibilityCacheEntry> {
    const existing = pendingVisibilityCacheBySession.get(sessionId)
    if (existing) {
        return existing
    }
    const created = new Map<string, PendingVisibilityCacheEntry>()
    pendingVisibilityCacheBySession.set(sessionId, created)
    return created
}

function clearPendingVisibilityCache(sessionId: string): void {
    pendingVisibilityCacheBySession.delete(sessionId)
}

function isVisiblePendingMessage(sessionId: string, message: DecryptedMessage): boolean {
    const cache = getPendingVisibilityCache(sessionId)
    const cached = cache.get(message.id)
    if (cached && cached.source === message) {
        return cached.visible
    }
    const visible = normalizeDecryptedMessage(message) !== null
    cache.set(message.id, { source: message, visible })
    return visible
}

function countVisiblePendingMessages(sessionId: string, messages: DecryptedMessage[]): number {
    let count = 0
    for (const message of messages) {
        if (isVisiblePendingMessage(sessionId, message)) {
            count += 1
        }
    }
    return count
}

function syncPendingVisibilityCache(sessionId: string, pending: DecryptedMessage[]): void {
    const cache = pendingVisibilityCacheBySession.get(sessionId)
    if (!cache) {
        return
    }
    const keep = new Set(pending.map((message) => message.id))
    for (const id of cache.keys()) {
        if (!keep.has(id)) {
            cache.delete(id)
        }
    }
}

function createState(sessionId: string): InternalState {
    return {
        sessionId,
        messages: [],
        pending: [],
        pendingCount: 0,
        pendingVisibleCount: 0,
        pendingOverflowVisibleCount: 0,
        hasMore: false,
        hasNewer: false,
        oldestSeq: null,
        newestSeq: null,
        isLoading: false,
        isLoadingMore: false,
        isLoadingNewer: false,
        warning: null,
        atBottom: true,
        messagesVersion: 0,
        pendingOverflowCount: 0,
        historyRequestGeneration: 0,
        latestPageCache: [],
        latestPageHasMore: false,
    }
}

function getState(sessionId: string): InternalState {
    const existing = states.get(sessionId)
    if (existing) {
        return existing
    }
    const created = createState(sessionId)
    states.set(sessionId, created)
    return created
}

function notify(sessionId: string): void {
    scheduleNotify(sessionId)
}

function notifyImmediate(sessionId: string): void {
    // Bypass throttle for user-initiated actions (flush, clear, etc.)
    const subs = listeners.get(sessionId)
    if (!subs) return
    for (const listener of subs) {
        listener()
    }
}

function setState(sessionId: string, next: InternalState, immediate?: boolean): void {
    states.set(sessionId, next)
    if (immediate) {
        notifyImmediate(sessionId)
    } else {
        notify(sessionId)
    }
}

function updateState(sessionId: string, updater: (prev: InternalState) => InternalState, immediate?: boolean): void {
    const prev = getState(sessionId)
    const next = updater(prev)
    if (next !== prev) {
        setState(sessionId, next, immediate)
    }
}

function deriveSeqBounds(messages: DecryptedMessage[]): { oldestSeq: number | null; newestSeq: number | null } {
    let oldest: number | null = null
    let newest: number | null = null
    for (const message of messages) {
        if (typeof message.seq !== 'number') {
            continue
        }
        if (oldest === null || message.seq < oldest) {
            oldest = message.seq
        }
        if (newest === null || message.seq > newest) {
            newest = message.seq
        }
    }
    return { oldestSeq: oldest, newestSeq: newest }
}

function buildState(
    prev: InternalState,
    updates: {
        messages?: DecryptedMessage[]
        pending?: DecryptedMessage[]
        pendingOverflowCount?: number
        pendingVisibleCount?: number
        pendingOverflowVisibleCount?: number
        hasMore?: boolean
        hasNewer?: boolean
        isLoading?: boolean
        isLoadingMore?: boolean
        isLoadingNewer?: boolean
        warning?: string | null
        atBottom?: boolean
        latestPageCache?: DecryptedMessage[]
        latestPageHasMore?: boolean
    }
): InternalState {
    const messages = updates.messages ?? prev.messages
    const pending = updates.pending ?? prev.pending
    const pendingOverflowCount = updates.pendingOverflowCount ?? prev.pendingOverflowCount
    const pendingOverflowVisibleCount = updates.pendingOverflowVisibleCount ?? prev.pendingOverflowVisibleCount
    let pendingVisibleCount = updates.pendingVisibleCount ?? prev.pendingVisibleCount
    const pendingChanged = pending !== prev.pending
    if (pendingChanged && updates.pendingVisibleCount === undefined) {
        pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    }
    if (pendingChanged) {
        syncPendingVisibilityCache(prev.sessionId, pending)
    }
    const pendingCount = pendingVisibleCount + pendingOverflowVisibleCount
    const { oldestSeq, newestSeq } = deriveSeqBounds(messages)
    const messagesVersion = messages === prev.messages ? prev.messagesVersion : prev.messagesVersion + 1

    return {
        ...prev,
        messages,
        pending,
        pendingOverflowCount,
        pendingVisibleCount,
        pendingOverflowVisibleCount,
        pendingCount,
        oldestSeq,
        newestSeq,
        hasMore: updates.hasMore !== undefined ? updates.hasMore : prev.hasMore,
        hasNewer: updates.hasNewer !== undefined ? updates.hasNewer : prev.hasNewer,
        isLoading: updates.isLoading !== undefined ? updates.isLoading : prev.isLoading,
        isLoadingMore: updates.isLoadingMore !== undefined ? updates.isLoadingMore : prev.isLoadingMore,
        isLoadingNewer: updates.isLoadingNewer !== undefined ? updates.isLoadingNewer : prev.isLoadingNewer,
        warning: updates.warning !== undefined ? updates.warning : prev.warning,
        atBottom: updates.atBottom !== undefined ? updates.atBottom : prev.atBottom,
        messagesVersion,
        latestPageCache: updates.latestPageCache ?? prev.latestPageCache,
        latestPageHasMore: updates.latestPageHasMore ?? prev.latestPageHasMore,
    }
}

function getLatestPageSlice(messages: DecryptedMessage[]): DecryptedMessage[] {
    if (messages.length <= PAGE_SIZE) {
        return messages
    }
    return messages.slice(messages.length - PAGE_SIZE)
}

function mergeLatestPageCache(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (incoming.length === 0) {
        return existing
    }
    return getLatestPageSlice(mergeMessages(existing, incoming))
}

/**
 * Hard safety cap only for pathological history browsing (thousands of msgs).
 * Normal "load older" growth is intentionally unbounded so we never drop the
 * live bottom of the chat into a "Load more" gap.
 */
const PREPEND_HARD_MAX = VISIBLE_WINDOW_SIZE * 6

function trimVisible(messages: DecryptedMessage[], mode: 'append' | 'prepend'): TrimResult {
    if (messages.length <= VISIBLE_WINDOW_SIZE) {
        return {
            visible: messages,
            droppedOlder: 0,
            droppedNewer: 0
        }
    }

    const overflow = messages.length - VISIBLE_WINDOW_SIZE
    if (mode === 'prepend') {
        // Loading older must NOT discard the newest messages already on screen.
        // Old behavior: slice(0, WINDOW) kept older pages and set hasNewer,
        // so a tool-dense scroll-up replaced the uncollapsed bottom with "Load more".
        if (messages.length <= PREPEND_HARD_MAX) {
            return {
                visible: messages,
                droppedOlder: 0,
                droppedNewer: 0
            }
        }
        // Extreme size only: drop oldest, keep the live tail.
        const hardOverflow = messages.length - PREPEND_HARD_MAX
        return {
            visible: messages.slice(hardOverflow),
            droppedOlder: hardOverflow,
            droppedNewer: 0
        }
    }

    return {
        visible: messages.slice(overflow),
        droppedOlder: overflow,
        droppedNewer: 0
    }
}

function trimPending(
    sessionId: string,
    messages: DecryptedMessage[]
): { pending: DecryptedMessage[]; dropped: number; droppedVisible: number } {
    if (messages.length <= PENDING_WINDOW_SIZE) {
        return { pending: messages, dropped: 0, droppedVisible: 0 }
    }
    const cutoff = messages.length - PENDING_WINDOW_SIZE
    const droppedMessages = messages.slice(0, cutoff)
    const pending = messages.slice(cutoff)
    const droppedVisible = countVisiblePendingMessages(sessionId, droppedMessages)
    return { pending, dropped: droppedMessages.length, droppedVisible }
}

function filterPendingAgainstVisible(pending: DecryptedMessage[], visible: DecryptedMessage[]): DecryptedMessage[] {
    if (pending.length === 0 || visible.length === 0) {
        return pending
    }
    const visibleIds = new Set(visible.map((message) => message.id))
    return pending.filter((message) => !visibleIds.has(message.id))
}

function isOptimisticMessage(message: DecryptedMessage): boolean {
    return Boolean(message.localId && message.id === message.localId)
}

function mergeIntoPending(
    prev: InternalState,
    incoming: DecryptedMessage[],
    visibleMessages: DecryptedMessage[] = prev.messages
): {
    pending: DecryptedMessage[]
    pendingVisibleCount: number
    pendingOverflowCount: number
    pendingOverflowVisibleCount: number
    warning: string | null
} {
    if (incoming.length === 0) {
        return {
            pending: prev.pending,
            pendingVisibleCount: prev.pendingVisibleCount,
            pendingOverflowCount: prev.pendingOverflowCount,
            pendingOverflowVisibleCount: prev.pendingOverflowVisibleCount,
            warning: prev.warning
        }
    }
    const mergedPending = mergeMessages(prev.pending, incoming)
    const filtered = filterPendingAgainstVisible(mergedPending, visibleMessages)
    const { pending, dropped, droppedVisible } = trimPending(prev.sessionId, filtered)
    const pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    const pendingOverflowCount = prev.pendingOverflowCount + dropped
    const pendingOverflowVisibleCount = prev.pendingOverflowVisibleCount + droppedVisible
    const warning = droppedVisible > 0 && !prev.warning ? PENDING_OVERFLOW_WARNING : prev.warning
    return { pending, pendingVisibleCount, pendingOverflowCount, pendingOverflowVisibleCount, warning }
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return getState(sessionId)
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
    const subs = listeners.get(sessionId) ?? new Set()
    subs.add(listener)
    listeners.set(sessionId, subs)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
            states.delete(sessionId)
            clearPendingVisibilityCache(sessionId)
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    clearPendingVisibilityCache(sessionId)
    if (!states.has(sessionId)) {
        return
    }
    setState(sessionId, createState(sessionId), true)
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
        return
    }
    const source = getState(fromSessionId)
    const base = createState(toSessionId)
    const next = buildState(base, {
        messages: [...source.messages],
        pending: [...source.pending],
        pendingOverflowCount: source.pendingOverflowCount,
        pendingOverflowVisibleCount: source.pendingOverflowVisibleCount,
        hasMore: source.hasMore,
        hasNewer: source.hasNewer,
        warning: source.warning,
        atBottom: source.atBottom,
        isLoading: false,
        isLoadingMore: false,
        isLoadingNewer: false,
        latestPageCache: [...source.latestPageCache],
        latestPageHasMore: source.latestPageHasMore,
    })
    setState(toSessionId, next)
}

export async function fetchLatestMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoading) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoading: true, warning: null }))

    try {
        const response = await api.getMessages(sessionId, { limit: PAGE_SIZE, beforeSeq: null })
        updateState(sessionId, (prev) => {
            const nextLatestCache = mergeLatestPageCache(prev.latestPageCache, [...prev.pending, ...response.messages])
            if (prev.atBottom) {
                const merged = mergeMessages(prev.messages, [...prev.pending, ...response.messages])
                const trimmed = trimVisible(merged, 'append')
                return buildState(prev, {
                    messages: trimmed.visible,
                    pending: [],
                    pendingOverflowCount: 0,
                    pendingVisibleCount: 0,
                    pendingOverflowVisibleCount: 0,
                    hasMore: response.page.hasMore || trimmed.droppedOlder > 0,
                    hasNewer: false,
                    isLoading: false,
                    warning: null,
                    latestPageCache: nextLatestCache,
                    latestPageHasMore: response.page.hasMore,
                })
            }
            const pendingResult = mergeIntoPending(prev, response.messages)
            return buildState(prev, {
                pending: pendingResult.pending,
                pendingVisibleCount: pendingResult.pendingVisibleCount,
                pendingOverflowCount: pendingResult.pendingOverflowCount,
                pendingOverflowVisibleCount: pendingResult.pendingOverflowVisibleCount,
                isLoading: false,
                warning: pendingResult.warning,
                latestPageCache: nextLatestCache,
                latestPageHasMore: response.page.hasMore,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoading: false, warning: message }))
    }
}

/**
 * Fill every sequence page missed while SSE was disconnected. A latest-page
 * refresh alone can silently skip messages when the gap exceeds PAGE_SIZE.
 */
export async function catchUpMessagesAfterReconnect(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    const knownMessages = [...initial.messages, ...initial.pending, ...initial.latestPageCache]
    const { newestSeq } = deriveSeqBounds(knownMessages)
    if (newestSeq === null) {
        await fetchLatestMessages(api, sessionId)
        return
    }

    const collected: DecryptedMessage[] = []
    let cursor = newestSeq
    try {
        while (true) {
            const response = await api.getMessages(sessionId, {
                limit: RECONNECT_PAGE_SIZE,
                afterSeq: cursor,
            })
            collected.push(...response.messages)

            const nextCursor = response.page.nextAfterSeq
                ?? deriveSeqBounds(response.messages).newestSeq
            if (!response.page.hasMore || nextCursor === null || nextCursor <= cursor) {
                break
            }
            cursor = nextCursor
        }
        ingestIncomingMessages(sessionId, collected)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to catch up messages'
        updateState(sessionId, (prev) => buildState(prev, { warning: message }))
        throw error
    }
}

export async function snapToLatestMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.latestPageCache.length > 0) {
        updateState(sessionId, (prev) => ({
            ...buildState(prev, {
                messages: prev.latestPageCache,
                pending: [],
                pendingOverflowCount: 0,
                pendingVisibleCount: 0,
                pendingOverflowVisibleCount: 0,
                hasMore: prev.latestPageHasMore,
                hasNewer: false,
                isLoading: false,
                isLoadingMore: false,
                isLoadingNewer: false,
                warning: null,
                atBottom: true,
            }),
            historyRequestGeneration: prev.historyRequestGeneration + 1,
        }))
        return
    }

    if (initial.isLoading || initial.isLoadingMore || initial.isLoadingNewer) {
        return
    }

    updateState(sessionId, (prev) => buildState(prev, {
        isLoadingNewer: true,
        warning: null,
    }))

    try {
        const response = await api.getMessages(sessionId, { limit: PAGE_SIZE, beforeSeq: null })
        updateState(sessionId, (prev) => buildState(prev, {
            messages: response.messages,
            pending: [],
            pendingOverflowCount: 0,
            pendingVisibleCount: 0,
            pendingOverflowVisibleCount: 0,
            hasMore: response.page.hasMore,
            hasNewer: false,
            isLoading: false,
            isLoadingMore: false,
            isLoadingNewer: false,
            warning: null,
            atBottom: true,
            latestPageCache: response.messages,
            latestPageHasMore: response.page.hasMore,
        }))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load latest messages'
        updateState(sessionId, (prev) => buildState(prev, {
            isLoadingNewer: false,
            warning: message,
        }))
    }
}

/**
 * True when a message carries normal chat text (user prompt or assistant prose).
 * Tool-only / thinking-only turns are false so Load older can skip over pure tool runs.
 */
export function messageHasNormalText(message: DecryptedMessage): boolean {
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized) {
        return false
    }
    if (normalized.role === 'user') {
        return typeof normalized.content.text === 'string' && normalized.content.text.trim().length > 0
    }
    if (normalized.role === 'agent') {
        return normalized.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
    }
    return false
}

function pageHasNormalText(messages: readonly DecryptedMessage[]): boolean {
    return messages.some((message) => messageHasNormalText(message))
}

export async function fetchOlderMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoadingMore || initial.isLoadingNewer || !initial.hasMore) {
        return
    }
    if (initial.oldestSeq === null) {
        return
    }
    const requestGeneration = initial.historyRequestGeneration
    updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: true }))

    try {
        const collected: DecryptedMessage[] = []
        let cursor: number | null = initial.oldestSeq
        let hasMore: boolean = initial.hasMore
        // Keep pulling older pages while they are pure tool activity (which collapses
        // into grouped tool cards). Stop once we surface a normal text message so
        // the top of the thread is not "Load older + tool groups only".
        for (let page = 0; page < OLDER_SKIP_TOOL_ONLY_MAX_PAGES; page += 1) {
            if (!hasMore || cursor === null) {
                break
            }

            const response = await api.getMessages(sessionId, {
                limit: PAGE_SIZE,
                beforeSeq: cursor,
            })

            // A user action such as Go to latest replaced the visible window
            // while this request was in flight. Never merge that stale page.
            if (getState(sessionId).historyRequestGeneration !== requestGeneration) {
                return
            }

            collected.push(...response.messages)
            hasMore = response.page.hasMore
            cursor = deriveSeqBounds(response.messages).oldestSeq

            if (response.messages.length === 0) {
                break
            }
            if (pageHasNormalText(response.messages)) {
                break
            }
            if (!response.page.hasMore) {
                break
            }
        }

        updateState(sessionId, (prev) => {
            const merged = mergeMessages(collected, prev.messages)
            const trimmed = trimVisible(merged, 'prepend')
            const pending = filterPendingAgainstVisible(prev.pending, trimmed.visible)
            return buildState(prev, {
                messages: trimmed.visible,
                pending,
                hasMore: hasMore || trimmed.droppedOlder > 0,
                hasNewer: prev.hasNewer || trimmed.droppedNewer > 0,
                isLoadingMore: false,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: false, warning: message }))
        return
    }

}

export async function fetchNewerMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoadingNewer || initial.isLoadingMore) {
        return
    }
    if (!initial.hasNewer && initial.pending.length === 0) {
        return
    }
    if (initial.newestSeq === null) {
        return
    }

    updateState(sessionId, (prev) => buildState(prev, { isLoadingNewer: true }))

    try {
        const collected: DecryptedMessage[] = []
        let cursor = initial.newestSeq
        let hasMore = initial.hasNewer

        for (let page = 0; page < NEWER_BATCH_MAX_PAGES; page += 1) {
            const response = await api.getMessages(sessionId, {
                limit: PAGE_SIZE,
                afterSeq: cursor,
            })

            if (response.messages.length > 0) {
                collected.push(...response.messages)
            }

            hasMore = response.page.hasMore
            const nextAfterSeq = response.page.nextAfterSeq
            if (!hasMore || nextAfterSeq === null || nextAfterSeq <= cursor) {
                break
            }
            cursor = nextAfterSeq
        }

        updateState(sessionId, (prev) => {
            const merged = mergeMessages(prev.messages, collected)
            const mergedWithPending = mergeMessages(merged, prev.pending)
            // Loading newer while browsing history: keep older messages on
            // screen; dropping them would shift the viewport under the reader.
            const trimmed = trimVisible(mergedWithPending, 'prepend')
            return buildState(prev, {
                messages: trimmed.visible,
                pending: [],
                pendingOverflowCount: 0,
                pendingVisibleCount: 0,
                pendingOverflowVisibleCount: 0,
                hasMore: prev.hasMore || trimmed.droppedOlder > 0,
                hasNewer: hasMore,
                isLoadingNewer: false,
                warning: null,
                latestPageCache: mergeLatestPageCache(prev.latestPageCache, [...collected, ...prev.pending]),
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoadingNewer: false, warning: message }))
    }
}

export async function focusMessageWindow(api: ApiClient, sessionId: string, targetSeq: number): Promise<boolean> {
    if (!Number.isFinite(targetSeq) || targetSeq < 1) {
        return false
    }

    const safeTargetSeq = Math.floor(targetSeq)
    updateState(sessionId, (prev) => buildState(prev, {
        isLoading: true,
        isLoadingMore: false,
        isLoadingNewer: false,
        warning: null,
    }))

    try {
        const [beforeResponse, afterResponse] = await Promise.all([
            api.getMessages(sessionId, {
                limit: FOCUS_WINDOW_BEFORE,
                beforeSeq: safeTargetSeq + 1,
            }),
            api.getMessages(sessionId, {
                limit: FOCUS_WINDOW_AFTER,
                afterSeq: safeTargetSeq,
            })
        ])

        const merged = mergeMessages(beforeResponse.messages, afterResponse.messages)
        const hasTarget = merged.some((message) => typeof message.seq === 'number' && message.seq === safeTargetSeq)
        if (!hasTarget) {
            updateState(sessionId, (prev) => buildState(prev, { isLoading: false }))
            return false
        }

        updateState(sessionId, (prev) => {
            const pending = filterPendingAgainstVisible(prev.pending, merged)
            return buildState(prev, {
                messages: merged,
                pending,
                hasMore: beforeResponse.page.hasMore,
                hasNewer: afterResponse.page.hasMore,
                isLoading: false,
                warning: null,
                atBottom: false,
            })
        })

        return true
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to locate message'
        updateState(sessionId, (prev) => buildState(prev, {
            isLoading: false,
            warning: message,
        }))
        return false
    }
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
    if (incoming.length === 0) {
        return
    }
    updateState(sessionId, (prev) => {
        if (prev.atBottom) {
            const merged = mergeMessages(prev.messages, incoming)
            const trimmed = trimVisible(merged, 'append')
            const pending = filterPendingAgainstVisible(prev.pending, trimmed.visible)
            return buildState(prev, {
                messages: trimmed.visible,
                pending,
                hasMore: prev.hasMore || trimmed.droppedOlder > 0,
                hasNewer: false,
                latestPageCache: mergeLatestPageCache(prev.latestPageCache, incoming),
            })
        }
        // Away from the bottom, show agent messages immediately and queue only
        // user messages. Delaying agent replies would block the interaction.
        const agentMessages = incoming.filter(msg => !isUserMessage(msg))
        const userMessages = incoming.filter(msg => isUserMessage(msg))

        let state = prev
        if (agentMessages.length > 0) {
            const merged = mergeMessages(state.messages, agentMessages)
            // Not at bottom: never drop older messages — the user may be reading
            // them, and removing content above the viewport visibly shifts the
            // scroll position (overflow-anchor is disabled on .chat-viewport).
            const trimmed = trimVisible(merged, 'prepend')
            const pending = filterPendingAgainstVisible(state.pending, trimmed.visible)
            state = buildState(state, {
                messages: trimmed.visible,
                pending,
                hasMore: state.hasMore || trimmed.droppedOlder > 0,
            })
        }
        if (userMessages.length > 0) {
            const pendingResult = mergeIntoPending(state, userMessages)
            state = buildState(state, {
                pending: pendingResult.pending,
                pendingVisibleCount: pendingResult.pendingVisibleCount,
                pendingOverflowCount: pendingResult.pendingOverflowCount,
                pendingOverflowVisibleCount: pendingResult.pendingOverflowVisibleCount,
                warning: pendingResult.warning,
            })
        }
        return buildState(state, {
            latestPageCache: mergeLatestPageCache(state.latestPageCache, incoming),
        })
    })
}

export function flushPendingMessages(sessionId: string): boolean {
    const current = getState(sessionId)
    if (current.pending.length === 0 && current.pendingOverflowVisibleCount === 0) {
        return false
    }
    const needsRefresh = current.pendingOverflowVisibleCount > 0
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, prev.pending)
        const trimmed = trimVisible(merged, 'append')
        return buildState(prev, {
            messages: trimmed.visible,
            pending: [],
            pendingOverflowCount: 0,
            pendingVisibleCount: 0,
            pendingOverflowVisibleCount: 0,
            hasMore: prev.hasMore || trimmed.droppedOlder > 0,
            warning: needsRefresh ? (prev.warning ?? PENDING_OVERFLOW_WARNING) : prev.warning,
        })
    }, true)
    return needsRefresh
}

export function setAtBottom(sessionId: string, atBottom: boolean): void {
    updateState(sessionId, (prev) => {
        if (prev.atBottom === atBottom) {
            return prev
        }
        return buildState(prev, { atBottom })
    }, true)
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, [message])
        const trimmed = trimVisible(merged, 'append')
        const pending = filterPendingAgainstVisible(prev.pending, trimmed.visible)
        return buildState(prev, {
            messages: trimmed.visible,
            pending,
            hasMore: prev.hasMore || trimmed.droppedOlder > 0,
            hasNewer: false,
            atBottom: true,
            latestPageCache: mergeLatestPageCache(prev.latestPageCache, [message]),
        })
    }, true)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    if (!localId) {
        return
    }
    updateState(sessionId, (prev) => {
        let changed = false
        const updateList = (list: DecryptedMessage[]) => {
            return list.map((message) => {
                if (message.localId !== localId || !isOptimisticMessage(message)) {
                    return message
                }
                if (message.status === status) {
                    return message
                }
                changed = true
                return { ...message, status }
            })
        }
        const messages = updateList(prev.messages)
        const pending = updateList(prev.pending)
        const latestPageCache = updateList(prev.latestPageCache)
        if (!changed) {
            return prev
        }
        return buildState(prev, { messages, pending, latestPageCache })
    })
}
