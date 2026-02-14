import type { Database } from 'bun:sqlite'

import type { StoredMessage } from './types'
import { addMessage, copyMessagesToSession, getMessages, getMessagesAfter, getMessagesSince, getMessagesUpToSeq, mergeSessionMessages } from './messages'

export class MessageStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addMessage(sessionId: string, content: unknown, localId?: string): StoredMessage {
        return addMessage(this.db, sessionId, content, localId)
    }

    getMessages(sessionId: string, limit: number = 200, beforeSeq?: number): StoredMessage[] {
        return getMessages(this.db, sessionId, limit, beforeSeq)
    }

    getMessagesAfter(sessionId: string, afterSeq: number, limit: number = 200): StoredMessage[] {
        return getMessagesAfter(this.db, sessionId, afterSeq, limit)
    }

    getMessagesUpToSeq(sessionId: string, maxSeq: number, limit: number = 200): StoredMessage[] {
        return getMessagesUpToSeq(this.db, sessionId, maxSeq, limit)
    }

    copyMessagesToSession(fromSessionId: string, toSessionId: string, maxSeq?: number): number {
        return copyMessagesToSession(this.db, fromSessionId, toSessionId, maxSeq)
    }

    mergeSessionMessages(fromSessionId: string, toSessionId: string): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
        return mergeSessionMessages(this.db, fromSessionId, toSessionId)
    }

    getMessagesSince(since: number, limit?: number, cursor?: string): { messages: StoredMessage[]; cursor: string | null; hasMore: boolean } {
        return getMessagesSince(this.db, since, limit, cursor)
    }
}
