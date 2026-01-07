import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
import { mergeMessages } from '@/lib/messages'

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    pending: DecryptedMessage[]
    pendingCount: number
    hasMore: boolean
    oldestSeq: number | null
    newestSeq: number | null
    isLoading: boolean
    isLoadingMore: boolean
    warning: string | null
    atBottom: boolean
    messagesVersion: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const PENDING_WINDOW_SIZE = 200
const PAGE_SIZE = 50
const PENDING_OVERFLOW_WARNING = 'New messages arrived while you were away. Scroll to bottom to refresh.'

type InternalState = MessageWindowState & {
    pendingOverflowCount: number
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()

function createState(sessionId: string): InternalState {
    return {
        sessionId,
        messages: [],
        pending: [],
        pendingCount: 0,
        hasMore: false,
        oldestSeq: null,
        newestSeq: null,
        isLoading: false,
        isLoadingMore: false,
        warning: null,
        atBottom: true,
        messagesVersion: 0,
        pendingOverflowCount: 0,
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
    const subs = listeners.get(sessionId)
    if (!subs) return
    for (const listener of subs) {
        listener()
    }
}

function setState(sessionId: string, next: InternalState): void {
    states.set(sessionId, next)
    notify(sessionId)
}

function updateState(sessionId: string, updater: (prev: InternalState) => InternalState): void {
    const prev = getState(sessionId)
    const next = updater(prev)
    if (next !== prev) {
        setState(sessionId, next)
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
        hasMore?: boolean
        isLoading?: boolean
        isLoadingMore?: boolean
        warning?: string | null
        atBottom?: boolean
    }
): InternalState {
    const messages = updates.messages ?? prev.messages
    const pending = updates.pending ?? prev.pending
    const pendingOverflowCount = updates.pendingOverflowCount ?? prev.pendingOverflowCount
    const pendingCount = pending.length + pendingOverflowCount
    const { oldestSeq, newestSeq } = deriveSeqBounds(messages)
    const messagesVersion = messages === prev.messages ? prev.messagesVersion : prev.messagesVersion + 1

    return {
        ...prev,
        messages,
        pending,
        pendingOverflowCount,
        pendingCount,
        oldestSeq,
        newestSeq,
        hasMore: updates.hasMore !== undefined ? updates.hasMore : prev.hasMore,
        isLoading: updates.isLoading !== undefined ? updates.isLoading : prev.isLoading,
        isLoadingMore: updates.isLoadingMore !== undefined ? updates.isLoadingMore : prev.isLoadingMore,
        warning: updates.warning !== undefined ? updates.warning : prev.warning,
        atBottom: updates.atBottom !== undefined ? updates.atBottom : prev.atBottom,
        messagesVersion,
    }
}

function trimVisible(messages: DecryptedMessage[], mode: 'append' | 'prepend'): DecryptedMessage[] {
    if (messages.length <= VISIBLE_WINDOW_SIZE) {
        return messages
    }
    if (mode === 'prepend') {
        return messages.slice(0, VISIBLE_WINDOW_SIZE)
    }
    return messages.slice(messages.length - VISIBLE_WINDOW_SIZE)
}

function trimPending(messages: DecryptedMessage[]): { pending: DecryptedMessage[]; dropped: number } {
    if (messages.length <= PENDING_WINDOW_SIZE) {
        return { pending: messages, dropped: 0 }
    }
    const dropped = messages.length - PENDING_WINDOW_SIZE
    return { pending: messages.slice(messages.length - PENDING_WINDOW_SIZE), dropped }
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
    incoming: DecryptedMessage[]
): { pending: DecryptedMessage[]; pendingOverflowCount: number; warning: string | null } {
    if (incoming.length === 0) {
        return { pending: prev.pending, pendingOverflowCount: prev.pendingOverflowCount, warning: prev.warning }
    }
    const mergedPending = mergeMessages(prev.pending, incoming)
    const filtered = filterPendingAgainstVisible(mergedPending, prev.messages)
    const { pending, dropped } = trimPending(filtered)
    const pendingOverflowCount = prev.pendingOverflowCount + dropped
    const warning = dropped > 0 && !prev.warning ? PENDING_OVERFLOW_WARNING : prev.warning
    return { pending, pendingOverflowCount, warning }
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
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    if (!states.has(sessionId)) {
        return
    }
    setState(sessionId, createState(sessionId))
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
            if (prev.atBottom) {
                const merged = mergeMessages(prev.messages, [...prev.pending, ...response.messages])
                const trimmed = trimVisible(merged, 'append')
                return buildState(prev, {
                    messages: trimmed,
                    pending: [],
                    pendingOverflowCount: 0,
                    hasMore: response.page.hasMore,
                    isLoading: false,
                    warning: null,
                })
            }
            const pendingResult = mergeIntoPending(prev, response.messages)
            return buildState(prev, {
                pending: pendingResult.pending,
                pendingOverflowCount: pendingResult.pendingOverflowCount,
                isLoading: false,
                warning: pendingResult.warning,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoading: false, warning: message }))
    }
}

export async function fetchOlderMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoadingMore || !initial.hasMore) {
        return
    }
    if (initial.oldestSeq === null) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: true }))

    try {
        const response = await api.getMessages(sessionId, { limit: PAGE_SIZE, beforeSeq: initial.oldestSeq })
        updateState(sessionId, (prev) => {
            const merged = mergeMessages(response.messages, prev.messages)
            const trimmed = trimVisible(merged, 'prepend')
            return buildState(prev, {
                messages: trimmed,
                hasMore: response.page.hasMore,
                isLoadingMore: false,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: false, warning: message }))
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
            const pending = filterPendingAgainstVisible(prev.pending, trimmed)
            return buildState(prev, { messages: trimmed, pending })
        }
        const pendingResult = mergeIntoPending(prev, incoming)
        return buildState(prev, {
            pending: pendingResult.pending,
            pendingOverflowCount: pendingResult.pendingOverflowCount,
            warning: pendingResult.warning,
        })
    })
}

export function flushPendingMessages(sessionId: string): boolean {
    const current = getState(sessionId)
    if (current.pending.length === 0 && current.pendingOverflowCount === 0) {
        return false
    }
    const needsRefresh = current.pendingOverflowCount > 0
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, prev.pending)
        const trimmed = trimVisible(merged, 'append')
        return buildState(prev, {
            messages: trimmed,
            pending: [],
            pendingOverflowCount: 0,
            warning: needsRefresh ? (prev.warning ?? PENDING_OVERFLOW_WARNING) : prev.warning,
        })
    })
    return needsRefresh
}

export function setAtBottom(sessionId: string, atBottom: boolean): void {
    updateState(sessionId, (prev) => {
        if (prev.atBottom === atBottom) {
            return prev
        }
        return buildState(prev, { atBottom })
    })
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, [message])
        const trimmed = trimVisible(merged, 'append')
        const pending = filterPendingAgainstVisible(prev.pending, trimmed)
        return buildState(prev, { messages: trimmed, pending, atBottom: true })
    })
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
        if (!changed) {
            return prev
        }
        return buildState(prev, { messages, pending })
    })
}
