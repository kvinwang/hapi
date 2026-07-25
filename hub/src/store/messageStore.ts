import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import {
    addMessage,
    copyMessagesToSession,
    deleteMessageAtSeq,
    deleteMessagesAfterSeq,
    deleteMessagesBeforeSeq,
    getMessages,
    getClaudeReportedCost,
    getMessagesAfter,
    getMessagesInSeqRange,
    getMessagesSince,
    getMessagesUpToSeq,
    mergeSessionMessages,
    searchMessages,
    type StoredMessageRole
} from './messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string): StoredMessage {
        return addMessage(this.db, sessionId, content, localId)
    }

    getMessages(sessionId: string, limit: number = 200, beforeSeq?: number, role?: StoredMessageRole): StoredMessage[] {
        return getMessages(this.db, sessionId, limit, beforeSeq, role)
    }

    getClaudeReportedCost(sessionId: string): number | undefined {
        return getClaudeReportedCost(this.db, sessionId)
    }

    getMessagesAfter(sessionId: string, afterSeq: number, limit: number = 200, role?: StoredMessageRole): StoredMessage[] {
        return getMessagesAfter(this.db, sessionId, afterSeq, limit, role)
    }

    getMessagesInSeqRange(sessionId: string, firstSeq: number, lastSeq: number, limit: number = 500): StoredMessage[] {
        return getMessagesInSeqRange(this.db, sessionId, firstSeq, lastSeq, limit)
    }

    searchMessages(
        sessionId: string,
        search: string,
        options?: {
            limit?: number
            offset?: number
            afterSeq?: number
            beforeSeq?: number
        }
    ): StoredMessage[] {
        return searchMessages(this.db, sessionId, search, options)
    }

    getMessagesUpToSeq(sessionId: string, maxSeq: number, limit: number = 200): StoredMessage[] {
        return getMessagesUpToSeq(this.db, sessionId, maxSeq, limit)
    }

    copyMessagesToSession(fromSessionId: string, toSessionId: string, maxSeq?: number): number {
        return copyMessagesToSession(this.db, fromSessionId, toSessionId, maxSeq)
    }

    deleteMessagesBeforeSeq(sessionId: string, seq: number): number {
        return deleteMessagesBeforeSeq(this.db, sessionId, seq)
    }

    deleteMessagesAfterSeq(sessionId: string, seq: number): number {
        return deleteMessagesAfterSeq(this.db, sessionId, seq)
    }

    deleteMessageAtSeq(sessionId: string, seq: number): number {
        return deleteMessageAtSeq(this.db, sessionId, seq)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    getMessagesSince(since: number, limit?: number, cursor?: string): { messages: StoredMessage[]; cursor: string | null; hasMore: boolean } {
        return getMessagesSince(this.db, since, limit, cursor)
    }
}
