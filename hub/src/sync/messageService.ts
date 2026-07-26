import type { AttachmentMetadata, DecryptedMessage } from '@hapi/protocol/types'
import { isObject } from '@hapi/protocol'
import {
    compactToolRuns,
    expandPageEndToRunBoundary,
    expandPageStartToRunBoundary,
    getToolGroupSpan,
    type ToolGroupPageLoader
} from '@hapi/protocol/chat'
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

export type UserMessageHistoryResult = {
    messages: Array<{
        id: string
        seq: number
        createdAt: number
        text: string
    }>
    truncated: boolean
}

type MessagesPageOptions = {
    limit: number
    beforeSeq: number | null
    afterSeq: number | null
    role?: SessionHistoryRole
    /** Deliver complete, compacted tool runs instead of raw tool messages. */
    toolGroups?: boolean
}

/**
 * Rows one compacted page may read while trying to reach its block count. A
 * session can hold thousands of consecutive tool messages, and the reader is
 * better served by a page that stops short than by a request that walks the
 * whole history.
 */
const MAX_PAGE_FILL_SCAN = 2_000

/** Rows read per attempt while filling a compacted page; the store caps at 201. */
const PAGE_FILL_BATCH = 200

type MessagesPageResult = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        beforeSeq: number | null
        nextBeforeSeq: number | null
        afterSeq: number | null
        nextAfterSeq: number | null
        hasMore: boolean
    }
}

/** Lowest seq in a page; a compacted group reports the first seq it covers. */
function minSeq(messages: readonly DecryptedMessage[]): number | null {
    let lowest: number | null = null
    for (const message of messages) {
        const span = getToolGroupSpan(message.content)
        const seq = span ? span.firstSeq : message.seq
        if (typeof seq !== 'number') continue
        if (lowest === null || seq < lowest) lowest = seq
    }
    return lowest
}

/** Highest seq in a page; a compacted group reports the last seq it covers. */
function maxSeq(messages: readonly DecryptedMessage[]): number | null {
    let highest: number | null = null
    for (const message of messages) {
        const span = getToolGroupSpan(message.content)
        const seq = span ? span.lastSeq : message.seq
        if (typeof seq !== 'number') continue
        if (highest === null || seq > highest) highest = seq
    }
    return highest
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

    getMessagesPage(sessionId: string, options: MessagesPageOptions): MessagesPageResult {
        if (options.afterSeq !== null) {
            return this.getMessagesPageAfter(sessionId, options)
        }
        return this.getMessagesPageBefore(sessionId, options)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        const stored = this.store.messages.getMessagesAfter(sessionId, options.afterSeq, options.limit)
        return stored.map(toDecryptedMessage)
    }

    /**
     * Raw messages behind a compacted tool group, fetched when the user opens a
     * tool's details. The span comes from the group message the client holds.
     */
    getToolGroupMessages(
        sessionId: string,
        options: { firstSeq: number; lastSeq: number }
    ): DecryptedMessage[] {
        const firstSeq = Math.max(0, Math.floor(options.firstSeq))
        const lastSeq = Math.floor(options.lastSeq)
        if (!Number.isFinite(firstSeq) || !Number.isFinite(lastSeq) || lastSeq < firstSeq) {
            return []
        }
        return this.store.messages
            .getMessagesInSeqRange(sessionId, firstSeq, lastSeq)
            .map(toDecryptedMessage)
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

    getUserMessageHistory(sessionId: string, limit: number): UserMessageHistoryResult {
        const safeLimit = Math.max(1, Math.min(50_000, Math.floor(limit)))
        const messages: UserMessageHistoryResult['messages'] = []
        let cursor = 0
        while (messages.length <= safeLimit) {
            const batch = this.store.messages.getMessagesAfter(sessionId, cursor, 200, 'user')
            if (batch.length === 0) break
            for (const message of batch) {
                cursor = message.seq
                messages.push({
                    id: message.id,
                    seq: message.seq,
                    createdAt: message.createdAt,
                    text: this.analyzeMessageContent(message.content).text ?? ''
                })
                if (messages.length > safeLimit) break
            }
            if (batch.length < 200 || messages.length > safeLimit) break
        }
        return {
            messages: messages.slice(0, safeLimit),
            truncated: messages.length > safeLimit
        }
    }

    trimMessages(
        sessionId: string,
        options: { mode: 'before' | 'after' | 'single'; seq: number }
    ): { deleted: number } {
        const seq = this.normalizeSeqBoundary(options.seq, 0)
        if (seq === null) {
            return { deleted: 0 }
        }

        let deleted = 0
        if (options.mode === 'before') {
            deleted = this.store.messages.deleteMessagesBeforeSeq(sessionId, seq)
        } else if (options.mode === 'after') {
            deleted = this.store.messages.deleteMessagesAfterSeq(sessionId, seq)
        } else {
            deleted = this.store.messages.deleteMessageAtSeq(sessionId, seq)
        }

        return { deleted }
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
            const batch = this.store.messages.getMessagesAfter(sessionId, cursor, 200, options.role ?? undefined)
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

    private toolGroupLoader(sessionId: string): ToolGroupPageLoader {
        return {
            loadBefore: (seq, limit) => this.store.messages
                .getMessages(sessionId, limit, seq)
                .map(toDecryptedMessage),
            loadAfter: (seq, limit) => this.store.messages
                .getMessagesAfter(sessionId, seq, limit)
                .map(toDecryptedMessage)
        }
    }

    private getMessagesPageBefore(sessionId: string, options: MessagesPageOptions): MessagesPageResult {
        const read = (limit: number) => this.store.messages.getMessages(
            sessionId,
            limit + 1,
            options.beforeSeq ?? undefined,
            options.role
        )

        const stored = read(options.limit)
        let hasMore = stored.length > options.limit
        let messages: DecryptedMessage[] = (hasMore ? stored.slice(stored.length - options.limit) : stored)
            .map(toDecryptedMessage)

        if (options.toolGroups && !options.role) {
            const loader = this.toolGroupLoader(sessionId)
            const sessionMaxSeq = this.store.messages.getMaxSeq(sessionId)
            // The newer edge is the caller's cursor, which a previous page already
            // placed on a run boundary; only the older edge can split a run.
            const build = (raw: DecryptedMessage[]) => {
                const expanded = expandPageStartToRunBoundary(raw, loader)
                return { expanded, page: compactToolRuns(expanded, { sessionMaxSeq }) }
            }

            const first = build(messages)
            let page = first.page
            let scanned = first.expanded.length

            // `limit` asks for that many blocks to read, not that many rows to
            // scan. A tool-dense page collapses to a couple of cards, which
            // leaves the reader an unscrollable viewport and no way back into
            // the session, so keep reading older history until the page carries
            // what was asked for. Each batch is expanded to a run boundary
            // before it is compacted, so the seam between batches never falls
            // inside a run and the batches can simply be concatenated.
            while (page.length < options.limit && scanned < MAX_PAGE_FILL_SCAN) {
                const cursor = minSeq(page)
                if (cursor === null) break
                const older = loader.loadBefore(cursor, PAGE_FILL_BATCH)
                if (older.length === 0) break
                const next = build(older)
                scanned += next.expanded.length
                page = [...next.page, ...page]
            }
            messages = page
        }

        const oldestSeq = minSeq(messages)
        if (options.toolGroups && !options.role && oldestSeq !== null) {
            hasMore = this.store.messages.getMessages(sessionId, 1, oldestSeq).length > 0
        }

        return {
            messages,
            page: {
                limit: options.limit,
                beforeSeq: options.beforeSeq,
                nextBeforeSeq: oldestSeq,
                afterSeq: null,
                nextAfterSeq: null,
                hasMore
            }
        }
    }

    private getMessagesPageAfter(sessionId: string, options: MessagesPageOptions): MessagesPageResult {
        const afterSeq = options.afterSeq ?? 0
        const stored = this.store.messages.getMessagesAfter(
            sessionId,
            afterSeq,
            options.limit + 1,
            options.role
        )
        let hasMore = stored.length > options.limit
        let messages: DecryptedMessage[] = stored.slice(0, options.limit).map(toDecryptedMessage)

        if (options.toolGroups && !options.role) {
            // The older edge is the caller's cursor, which a previous page already
            // placed on a run boundary; only the newer edge can split a run.
            messages = expandPageEndToRunBoundary(messages, this.toolGroupLoader(sessionId))
            messages = compactToolRuns(messages, { sessionMaxSeq: this.store.messages.getMaxSeq(sessionId) })
        }

        const newestSeq = maxSeq(messages)
        if (options.toolGroups && !options.role && newestSeq !== null) {
            hasMore = this.store.messages.getMessagesAfter(sessionId, newestSeq, 1).length > 0
        }

        return {
            messages,
            page: {
                limit: options.limit,
                beforeSeq: null,
                nextBeforeSeq: null,
                afterSeq,
                nextAfterSeq: newestSeq,
                hasMore
            }
        }
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

        const targetCount = options.tail ?? options.limit

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
            // Role goes to SQL so idx_messages_session_role_seq does the filtering;
            // scanning every message and re-parsing its envelope here made a
            // role-filtered history walk cost the whole session.
            const batch = this.store.messages.getMessages(
                sessionId,
                200,
                beforeCursor ?? undefined,
                options.role ?? undefined
            )
            if (batch.length === 0) {
                break
            }

            for (let i = batch.length - 1; i >= 0; i -= 1) {
                const message = batch[i]
                if (options.afterSeq !== null && message.seq <= options.afterSeq) {
                    reachedLowerBoundary = true
                    break
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
            sentFrom?: 'telegram-bot' | 'webapp' | 'lobstear' | 'cli'
            deviceId?: string
            systemPrompt?: string
        }
    ): Promise<{ seq: number }> {
        const sentFrom = payload.sentFrom ?? 'webapp'

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text,
                attachments: payload.attachments
            },
            meta: {
                sentFrom,
                ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
                ...(payload.systemPrompt ? { appendSystemPrompt: payload.systemPrompt } : {})
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

        return { seq: msg.seq! }
    }
}
