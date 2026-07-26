import type { InfiniteData } from '@tanstack/react-query'
import { getToolGroupCoverage, getToolGroupSpan, toolGroupCoversSeq } from '@hapi/protocol/chat'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { randomId } from '@/lib/randomId'

export function makeClientSideId(prefix: string): string {
    return `${prefix}-${randomId()}`
}

export function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null

    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }

    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
    }
    return a.id.localeCompare(b.id)
}

function isSorted(messages: DecryptedMessage[]): boolean {
    for (let index = 1; index < messages.length; index += 1) {
        if (compareMessages(messages[index - 1], messages[index]) > 0) return false
    }
    return true
}

function canUseOrderedFastPath(messages: DecryptedMessage[]): boolean {
    return messages.every((message) => !isOptimisticMessage(message)) && isSorted(messages)
}

const sortedMessageArrays = new WeakSet<DecryptedMessage[]>()

function markSorted(messages: DecryptedMessage[]): DecryptedMessage[] {
    sortedMessageArrays.add(messages)
    return messages
}

/**
 * A tool run reaches the client either as raw messages (live, over SSE) or as one
 * compacted tool-group message (from history). Both can end up in the window
 * after paging back over ground that was streamed earlier. The compacted message
 * wins: it always covers the whole run, whereas the raw copies may be partial.
 */
function dropMessagesCoveredByToolGroups(messages: DecryptedMessage[]): DecryptedMessage[] {
    const spans = messages.map((message) => getToolGroupSpan(message.content))
    if (spans.every((span) => span === null)) return messages

    // A group stands for its whole span except the seqs it lists as kept —
    // reasoning, the newest usage line, a subagent call whose transcript hangs
    // off it. Those are delivered alongside and must survive.
    const coverages = messages
        .map((message) => getToolGroupCoverage(message.content))
        .filter((coverage): coverage is NonNullable<typeof coverage> => coverage !== null)

    const filtered = messages.filter((message, index) => {
        const own = spans[index]
        if (own) {
            // Drop a group another group fully contains — only reachable when one
            // side was cut short by the hub's run-expansion cap.
            return !spans.some((span, other) => (
                span !== null
                && other !== index
                && span.firstSeq <= own.firstSeq
                && span.lastSeq >= own.lastSeq
                && (span.firstSeq < own.firstSeq || span.lastSeq > own.lastSeq)
            ))
        }
        if (typeof message.seq !== 'number') return true
        return !coverages.some((coverage) => toolGroupCoversSeq(coverage, message.seq as number))
    })
    return filtered.length === messages.length ? messages : filtered
}

function finalizeMerge(result: DecryptedMessage[], existing: DecryptedMessage[]): DecryptedMessage[] {
    const deduped = dropMessagesCoveredByToolGroups(result)
    if (deduped.length === existing.length && deduped.every((message, index) => message === existing[index])) {
        sortedMessageArrays.add(existing)
        return existing
    }
    return markSorted(deduped)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return finalizeMerge([...incoming].sort(compareMessages), existing)
    }
    if (incoming.length === 0) {
        return existing
    }

    if (sortedMessageArrays.has(existing) && canUseOrderedFastPath(incoming)) {
        const existingFirst = existing[0]
        const existingLast = existing[existing.length - 1]
        const incomingFirst = incoming[0]
        const incomingLast = incoming[incoming.length - 1]
        if (compareMessages(existingLast, incomingFirst) < 0) {
            return finalizeMerge([...existing, ...incoming], existing)
        }
        if (compareMessages(incomingLast, existingFirst) < 0) {
            return finalizeMerge([...incoming, ...existing], existing)
        }
    }

    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        byId.set(msg.id, msg)
    }

    let merged = Array.from(byId.values())

    const incomingStoredLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            incomingStoredLocalIds.add(msg.localId)
        }
    }

    // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
    if (incomingStoredLocalIds.size > 0) {
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => isOptimisticMessage(m))
    const nonOptimisticMessages = merged.filter((m) => !isOptimisticMessage(m))
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                isUserMessage(m) &&
                Math.abs(m.createdAt - optimistic.createdAt) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    result.sort(compareMessages)
    return finalizeMerge(result, existing)
}

export function upsertMessagesInCache(
    data: InfiniteData<MessagesResponse> | undefined,
    incoming: DecryptedMessage[],
): InfiniteData<MessagesResponse> {
    const mergedIncoming = mergeMessages([], incoming)

    if (!data || data.pages.length === 0) {
        return {
            pages: [
                {
                    messages: mergedIncoming,
                    page: {
                        limit: 50,
                        beforeSeq: null,
                        nextBeforeSeq: null,
                        afterSeq: null,
                        nextAfterSeq: null,
                        hasMore: false,
                    },
                },
            ],
            pageParams: [null],
        }
    }

    const pages = data.pages.slice()
    const first = pages[0]
    pages[0] = {
        ...first,
        messages: mergeMessages(first.messages, mergedIncoming),
    }

    return {
        ...data,
        pages,
    }
}
