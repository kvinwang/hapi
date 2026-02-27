import type { AttachmentMetadata, DecryptedMessage } from '@hapi/protocol/types'
import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { Server } from 'socket.io'
import type { Store } from '../store'
import { EventPublisher } from './eventPublisher'

export type SessionHistoryRole = 'user' | 'assistant' | 'tool'

export type SessionHistoryEntry = DecryptedMessage & {
    role: SessionHistoryRole | null
    text: string | null
    snippet?: string
}

export type SessionHistoryOptions = {
    tail?: number
    search?: string
    role?: SessionHistoryRole
    afterSeq?: number
    beforeSeq?: number
    limit: number
    snippet?: boolean
}

export type SessionHistoryResult = {
    messages: SessionHistoryEntry[]
    query: {
        tail: number | null
        search: string | null
        role: SessionHistoryRole | null
        afterSeq: number | null
        beforeSeq: number | null
        limit: number
        snippet: boolean
    }
}

function toDecryptedMessage(message: {
    id: string
    seq: number
    localId: string | null
    content: unknown
    createdAt: number
}): DecryptedMessage {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        content: message.content,
        createdAt: message.createdAt
    }
}

export class MessageService {
    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher
    ) {
    }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null; role?: SessionHistoryRole }): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            beforeSeq: number | null
            nextBeforeSeq: number | null
            hasMore: boolean
        }
    } {
        const stored = this.store.messages.getMessages(
            sessionId,
            options.limit,
            options.beforeSeq ?? undefined,
            options.role
        )
        const messages: DecryptedMessage[] = stored.map(toDecryptedMessage)

        let oldestSeq: number | null = null
        for (const message of messages) {
            if (typeof message.seq !== 'number') continue
            if (oldestSeq === null || message.seq < oldestSeq) {
                oldestSeq = message.seq
            }
        }

        const nextBeforeSeq = oldestSeq
        const hasMore = nextBeforeSeq !== null
            && this.store.messages.getMessages(sessionId, 1, nextBeforeSeq, options.role).length > 0

        return {
            messages,
            page: {
                limit: options.limit,
                beforeSeq: options.beforeSeq,
                nextBeforeSeq,
                hasMore
            }
        }
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        const stored = this.store.messages.getMessagesAfter(sessionId, options.afterSeq, options.limit)
        return stored.map(toDecryptedMessage)
    }

    getLatestMessageSeq(sessionId: string): number {
        const latest = this.store.messages.getMessages(sessionId, 1)
        const seq = latest[0]?.seq
        return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0
    }

    getSessionHistory(sessionId: string, options: SessionHistoryOptions): SessionHistoryResult {
        const limit = this.normalizeLimit(options.limit)
        const tail = options.tail == null ? null : this.normalizeLimit(options.tail)
        const search = this.normalizeSearch(options.search)
        const role = options.role ?? null
        const afterSeq = this.normalizeSeqBoundary(options.afterSeq, 0)
        const beforeSeq = this.normalizeSeqBoundary(options.beforeSeq, 1)
        const includeSnippet = options.snippet === true

        const source = this.collectHistoryMessages(sessionId, {
            limit,
            tail,
            search,
            role,
            afterSeq,
            beforeSeq
        })

        const messages = source.map((message) => {
            const analyzed = this.analyzeMessageContent(message.content)
            const snippet = includeSnippet && search
                ? this.buildSearchSnippet(analyzed.text ?? this.safeStringify(message.content), search)
                : null

            return {
                id: message.id,
                seq: message.seq,
                localId: message.localId,
                content: message.content,
                createdAt: message.createdAt,
                role: analyzed.role,
                text: analyzed.text,
                ...(snippet ? { snippet } : {})
            }
        })

        return {
            messages,
            query: {
                tail,
                search,
                role,
                afterSeq,
                beforeSeq,
                limit,
                snippet: includeSnippet
            }
        }
    }

    private collectHistoryMessages(
        sessionId: string,
        options: {
            limit: number
            tail: number | null
            search: string | null
            role: SessionHistoryRole | null
            afterSeq: number | null
            beforeSeq: number | null
        }
    ): Array<{
        id: string
        seq: number
        localId: string | null
        content: unknown
        createdAt: number
    }> {
        if (!options.search && options.tail === null && options.afterSeq !== null) {
            return this.collectHistoryForward(sessionId, options)
        }
        return this.collectHistoryBackward(sessionId, options)
    }

    private collectHistoryForward(
        sessionId: string,
        options: {
            limit: number
            role: SessionHistoryRole | null
            beforeSeq: number | null
            afterSeq: number | null
        }
    ): Array<{
        id: string
        seq: number
        localId: string | null
        content: unknown
        createdAt: number
    }> {
        const results: Array<{
            id: string
            seq: number
            localId: string | null
            content: unknown
            createdAt: number
        }> = []
        let cursor = options.afterSeq ?? 0

        while (results.length < options.limit) {
            const batch = this.store.messages.getMessagesAfter(sessionId, cursor, 200)
            if (batch.length === 0) {
                break
            }

            let stop = false
            for (const message of batch) {
                cursor = message.seq
                if (options.beforeSeq !== null && message.seq >= options.beforeSeq) {
                    stop = true
                    break
                }

                const role = this.analyzeMessageContent(message.content).role
                if (options.role && options.role !== role) {
                    continue
                }

                results.push({
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId,
                    content: message.content,
                    createdAt: message.createdAt
                })
                if (results.length >= options.limit) {
                    stop = true
                    break
                }
            }

            if (stop || batch.length < 200) {
                break
            }
        }

        return results
    }

    private collectHistoryBackward(
        sessionId: string,
        options: {
            limit: number
            tail: number | null
            search: string | null
            role: SessionHistoryRole | null
            afterSeq: number | null
            beforeSeq: number | null
        }
    ): Array<{
        id: string
        seq: number
        localId: string | null
        content: unknown
        createdAt: number
    }> {
        if (options.search) {
            return this.collectHistorySearch(sessionId, options)
        }

        const targetCount = options.search
            ? options.limit
            : options.tail ?? options.limit

        const resultsNewestFirst: Array<{
            id: string
            seq: number
            localId: string | null
            content: unknown
            createdAt: number
        }> = []
        let beforeCursor = options.beforeSeq
        let reachedLowerBoundary = false

        while (resultsNewestFirst.length < targetCount) {
            const batch = this.store.messages.getMessages(sessionId, 200, beforeCursor ?? undefined)
            if (batch.length === 0) {
                break
            }

            for (let i = batch.length - 1; i >= 0; i -= 1) {
                const message = batch[i]
                if (options.afterSeq !== null && message.seq <= options.afterSeq) {
                    reachedLowerBoundary = true
                    break
                }

                const analyzed = this.analyzeMessageContent(message.content)
                if (options.role && options.role !== analyzed.role) {
                    continue
                }

                if (options.search) {
                    const haystack = (analyzed.text ?? this.safeStringify(message.content)).toLocaleLowerCase()
                    if (!haystack.includes(options.search.toLocaleLowerCase())) {
                        continue
                    }
                }

                resultsNewestFirst.push({
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId,
                    content: message.content,
                    createdAt: message.createdAt
                })
                if (resultsNewestFirst.length >= targetCount) {
                    break
                }
            }

            if (resultsNewestFirst.length >= targetCount || reachedLowerBoundary) {
                break
            }

            const oldest = batch[0]
            if (!oldest) {
                break
            }
            beforeCursor = oldest.seq
            if (batch.length < 200) {
                break
            }
        }

        return resultsNewestFirst.reverse()
    }

    private collectHistorySearch(
        sessionId: string,
        options: {
            limit: number
            search: string | null
            role: SessionHistoryRole | null
            afterSeq: number | null
            beforeSeq: number | null
        }
    ): Array<{
        id: string
        seq: number
        localId: string | null
        content: unknown
        createdAt: number
    }> {
        const query = options.search
        if (!query) {
            return []
        }

        const collectedNewestFirst: Array<{
            id: string
            seq: number
            localId: string | null
            content: unknown
            createdAt: number
        }> = []

        const batchSize = Math.max(20, Math.min(200, options.limit * 2))
        let offset = 0

        while (collectedNewestFirst.length < options.limit) {
            const batch = this.store.messages.searchMessages(sessionId, query, {
                limit: batchSize,
                offset,
                afterSeq: options.afterSeq ?? undefined,
                beforeSeq: options.beforeSeq ?? undefined
            })

            if (batch.length === 0) {
                break
            }

            offset += batch.length

            for (const message of batch) {
                if (options.role) {
                    const analyzed = this.analyzeMessageContent(message.content)
                    if (analyzed.role !== options.role) {
                        continue
                    }
                }

                collectedNewestFirst.push({
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId,
                    content: message.content,
                    createdAt: message.createdAt
                })

                if (collectedNewestFirst.length >= options.limit) {
                    break
                }
            }

            if (batch.length < batchSize) {
                break
            }
        }

        return collectedNewestFirst.reverse()
    }

    private analyzeMessageContent(content: unknown): { role: SessionHistoryRole | null; text: string | null } {
        const record = unwrapRoleWrappedRecordEnvelope(content)
        const rawRole = record?.role
        const role: SessionHistoryRole | null = rawRole === 'user'
            ? 'user'
            : rawRole === 'agent'
                ? 'assistant'
                : rawRole === 'tool'
                    ? 'tool'
                    : null

        const source = record?.content ?? content
        const text = this.extractTextFromContent(source)

        return { role, text }
    }

    private extractTextFromContent(content: unknown, depth: number = 0): string | null {
        if (depth > 5 || content === null || content === undefined) {
            return null
        }

        if (typeof content === 'string') {
            return this.normalizeText(content)
        }

        if (Array.isArray(content)) {
            const parts: string[] = []
            for (const entry of content) {
                if (!isObject(entry)) {
                    continue
                }
                const type = typeof entry.type === 'string' ? entry.type : ''
                if ((type === 'text' || type === 'input_text') && typeof entry.text === 'string') {
                    parts.push(entry.text)
                    continue
                }
                if (type === 'tool_result' && typeof entry.content === 'string') {
                    parts.push(entry.content)
                    continue
                }
                const nested = this.extractTextFromContent(entry.content, depth + 1)
                if (nested) {
                    parts.push(nested)
                }
            }
            return this.normalizeText(parts.join('\n'))
        }

        if (!isObject(content)) {
            return null
        }

        if (typeof content.text === 'string') {
            return this.normalizeText(content.text)
        }

        if (isObject(content.message)) {
            const nested = this.extractTextFromContent(content.message.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        if (isObject(content.data)) {
            if (isObject(content.data.message)) {
                const nested = this.extractTextFromContent(content.data.message.content, depth + 1)
                if (nested) {
                    return nested
                }
            }
            const nested = this.extractTextFromContent(content.data.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        if (isObject(content.payload)) {
            const nested = this.extractTextFromContent(content.payload.content, depth + 1)
            if (nested) {
                return nested
            }
        }

        return this.extractTextFromContent(content.content, depth + 1)
    }

    private normalizeText(text: string): string | null {
        const normalized = text.replace(/\s+/g, ' ').trim()
        return normalized.length > 0 ? normalized : null
    }

    private safeStringify(value: unknown): string {
        try {
            const stringified = JSON.stringify(value)
            return typeof stringified === 'string' ? stringified : ''
        } catch {
            return ''
        }
    }

    private buildSearchSnippet(text: string | null, keyword: string): string | null {
        if (!text) {
            return null
        }
        const normalized = text.replace(/\s+/g, ' ').trim()
        if (!normalized) {
            return null
        }

        const lower = normalized.toLocaleLowerCase()
        const target = keyword.toLocaleLowerCase()
        const index = lower.indexOf(target)
        const maxLength = 180
        if (index < 0) {
            return normalized.length <= maxLength
                ? normalized
                : `${normalized.slice(0, maxLength - 1)}…`
        }

        const half = Math.floor(maxLength / 2)
        const start = Math.max(0, index - half)
        const end = Math.min(normalized.length, start + maxLength)
        const prefix = start > 0 ? '…' : ''
        const suffix = end < normalized.length ? '…' : ''
        return `${prefix}${normalized.slice(start, end)}${suffix}`
    }

    private normalizeLimit(value: number): number {
        if (!Number.isFinite(value)) {
            return 20
        }
        return Math.max(1, Math.min(200, Math.floor(value)))
    }

    private normalizeSeqBoundary(value: number | undefined, min: number): number | null {
        if (value === undefined || value === null || !Number.isFinite(value)) {
            return null
        }
        const integer = Math.floor(value)
        if (integer < min) {
            return null
        }
        return integer
    }

    private normalizeSearch(value: string | undefined): string | null {
        if (typeof value !== 'string') {
            return null
        }
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : null
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: AttachmentMetadata[]
            sentFrom?: 'telegram-bot' | 'webapp'
        }
    ): Promise<void> {
        const sentFrom = payload.sentFrom ?? 'webapp'

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text,
                attachments: payload.attachments
            },
            meta: {
                sentFrom
            }
        }

        const msg = this.store.messages.addMessage(sessionId, content, payload.localId ?? undefined)

        const update = {
            id: msg.id,
            seq: msg.seq,
            createdAt: msg.createdAt,
            body: {
                t: 'new-message' as const,
                sid: sessionId,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)

        this.publisher.emit({
            type: 'message-received',
            sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt
            }
        })
    }
}
