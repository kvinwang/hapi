import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

import type { StoredMessage } from './types'
import { safeJsonParse } from './json'

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
    role: string | null
}

export type StoredMessageRole = 'user' | 'assistant' | 'tool'

export function inferMessageRole(content: unknown): StoredMessageRole | null {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (!record) {
        return null
    }
    if (record.role === 'user') {
        return 'user'
    }
    if (record.role === 'agent') {
        return 'assistant'
    }
    if (record.role === 'tool') {
        return 'tool'
    }
    return null
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id,
        role: row.role === 'user' || row.role === 'assistant' || row.role === 'tool' ? row.role : null
    }
}

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string
): StoredMessage {
    const now = Date.now()
    const role = inferMessageRole(content)

    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    const msgSeqRow = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const id = randomUUID()
    const json = JSON.stringify(content)

    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id, role
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id, @role
        )
    `).run({
        id,
        session_id: sessionId,
        content: json,
        created_at: now,
        seq: msgSeq,
        local_id: localId ?? null,
        role
    })

    return {
        id,
        sessionId,
        content,
        createdAt: now,
        seq: msgSeq,
        localId: localId ?? null,
        role
    }
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200,
    beforeSeq?: number,
    role?: StoredMessageRole
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(201, limit)) : 200

    const hasBeforeSeq = beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq)
    const hasRole = role === 'user' || role === 'assistant' || role === 'tool'
    const rows = (hasBeforeSeq && hasRole)
        ? db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq < ? AND role = ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, beforeSeq, role, safeLimit) as DbMessageRow[]
        : hasBeforeSeq
            ? db.prepare(
                'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
            ).all(sessionId, beforeSeq, safeLimit) as DbMessageRow[]
            : hasRole
                ? db.prepare(
                    'SELECT * FROM messages WHERE session_id = ? AND role = ? ORDER BY seq DESC LIMIT ?'
                ).all(sessionId, role, safeLimit) as DbMessageRow[]
                : db.prepare(
                    'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
                ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getClaudeReportedCost(db: Database, sessionId: string): number | undefined {
    const rows = db.prepare(`
        SELECT content
        FROM messages
        WHERE session_id = ?
          AND role = 'assistant'
          AND content LIKE '%"total_cost_usd"%'
        ORDER BY seq DESC
        LIMIT 1
    `).all(sessionId) as Array<{ content: string }>

    for (const row of rows) {
        const record = unwrapRoleWrappedRecordEnvelope(safeJsonParse(row.content))
        if (!record || record.role !== 'agent' || !record.content || typeof record.content !== 'object') continue
        const content = record.content as Record<string, unknown>
        if (content.type !== 'output' || !content.data || typeof content.data !== 'object') continue
        const data = content.data as Record<string, unknown>
        if (data.type !== 'result' || typeof data.total_cost_usd !== 'number' || !Number.isFinite(data.total_cost_usd)) continue
        return data.total_cost_usd
    }
    return undefined
}

export function getMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    limit: number = 200,
    role?: StoredMessageRole
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(201, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const hasRole = role === 'user' || role === 'assistant' || role === 'tool'
    const rows = hasRole
        ? db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq > ? AND role = ? ORDER BY seq ASC LIMIT ?'
        ).all(sessionId, safeAfterSeq, role, safeLimit) as DbMessageRow[]
        : db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
        ).all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMessagesInSeqRange(
    db: Database,
    sessionId: string,
    firstSeq: number,
    lastSeq: number,
    limit: number = 500
): StoredMessage[] {
    const safeFirst = Number.isFinite(firstSeq) ? Math.floor(firstSeq) : 0
    const safeLast = Number.isFinite(lastSeq) ? Math.floor(lastSeq) : safeFirst
    const lo = Math.min(safeFirst, safeLast)
    const hi = Math.max(safeFirst, safeLast)
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 500
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, lo, hi, safeLimit) as DbMessageRow[]
    return rows.map(toStoredMessage)
}

function normalizeFtsQuery(raw: string): string {
    const tokens = raw
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/"/g, ' ').trim())
        .filter((token) => token.length > 0)

    if (tokens.length === 0) {
        return ''
    }

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ')
}

export function searchMessages(
    db: Database,
    sessionId: string,
    search: string,
    options?: {
        limit?: number
        offset?: number
        afterSeq?: number
        beforeSeq?: number
    }
): StoredMessage[] {
    const query = normalizeFtsQuery(search)
    if (!query) {
        return []
    }

    const safeLimit = Number.isFinite(options?.limit) ? Math.max(1, Math.min(200, options?.limit as number)) : 50
    const safeOffset = Number.isFinite(options?.offset) ? Math.max(0, Math.floor(options?.offset as number)) : 0
    const hasAfterSeq = Number.isFinite(options?.afterSeq)
    const hasBeforeSeq = Number.isFinite(options?.beforeSeq)

    const rows = db.prepare(`
        SELECT m.*
        FROM messages_fts AS f
        INNER JOIN messages AS m ON m.rowid = f.rowid
        WHERE f.content MATCH @query
          AND m.session_id = @session_id
          AND (@has_after_seq = 0 OR m.seq > @after_seq)
          AND (@has_before_seq = 0 OR m.seq < @before_seq)
        ORDER BY m.seq DESC
        LIMIT @limit OFFSET @offset
    `).all({
        query,
        session_id: sessionId,
        has_after_seq: hasAfterSeq ? 1 : 0,
        after_seq: hasAfterSeq ? Math.floor(options?.afterSeq as number) : 0,
        has_before_seq: hasBeforeSeq ? 1 : 0,
        before_seq: hasBeforeSeq ? Math.floor(options?.beforeSeq as number) : 0,
        limit: safeLimit,
        offset: safeOffset
    }) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

export function getMessagesUpToSeq(
    db: Database,
    sessionId: string,
    maxSeq: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : 200
    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, maxSeq, safeLimit) as DbMessageRow[]
    return rows.reverse().map(toStoredMessage)
}

export function copyMessagesToSession(
    db: Database,
    fromSessionId: string,
    toSessionId: string,
    maxSeq?: number
): number {
    if (fromSessionId === toSessionId) {
        return 0
    }

    const query = maxSeq !== undefined && Number.isFinite(maxSeq)
        ? db.prepare(`
            INSERT INTO messages (id, session_id, content, created_at, seq, local_id, role)
            SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
                   @to_session_id, content, created_at, seq, NULL, role
            FROM messages
            WHERE session_id = @from_session_id AND seq <= @max_seq
            ORDER BY seq ASC
        `)
        : db.prepare(`
            INSERT INTO messages (id, session_id, content, created_at, seq, local_id, role)
            SELECT lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))),
                   @to_session_id, content, created_at, seq, NULL, role
            FROM messages
            WHERE session_id = @from_session_id
            ORDER BY seq ASC
        `)

    const result = query.run({
        to_session_id: toSessionId,
        from_session_id: fromSessionId,
        ...(maxSeq !== undefined && Number.isFinite(maxSeq) ? { max_seq: maxSeq } : {})
    })

    return result.changes
}

export function deleteMessagesBeforeSeq(
    db: Database,
    sessionId: string,
    seq: number
): number {
    const safeSeq = Number.isFinite(seq) ? Math.floor(seq) : 0
    if (safeSeq <= 0) return 0
    const result = db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND seq < ?'
    ).run(sessionId, safeSeq)
    return result.changes
}

export function deleteMessagesAfterSeq(
    db: Database,
    sessionId: string,
    seq: number
): number {
    const safeSeq = Number.isFinite(seq) ? Math.floor(seq) : 0
    if (safeSeq < 0) return 0
    const result = db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND seq > ?'
    ).run(sessionId, safeSeq)
    return result.changes
}

export function deleteMessageAtSeq(
    db: Database,
    sessionId: string,
    seq: number
): number {
    const safeSeq = Number.isFinite(seq) ? Math.floor(seq) : 0
    if (safeSeq <= 0) return 0
    const result = db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND seq = ?'
    ).run(sessionId, safeSeq)
    return result.changes
}

export function getMessagesSince(
    db: Database,
    since: number,
    limit: number = 500,
    cursor?: string
): { messages: StoredMessage[]; cursor: string | null; hasMore: boolean } {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : 500

    let rows: DbMessageRow[]
    if (cursor) {
        const parts = cursor.split(':')
        const cursorCreatedAt = Number(parts[0])
        const cursorId = parts[1]
        if (!Number.isFinite(cursorCreatedAt) || !cursorId) {
            rows = []
        } else {
            rows = db.prepare(
                `SELECT * FROM messages
                 WHERE created_at >= ? AND (created_at > ? OR (created_at = ? AND id > ?))
                 ORDER BY created_at ASC, id ASC
                 LIMIT ?`
            ).all(since, cursorCreatedAt, cursorCreatedAt, cursorId, safeLimit + 1) as DbMessageRow[]
        }
    } else {
        rows = db.prepare(
            `SELECT * FROM messages
             WHERE created_at >= ?
             ORDER BY created_at ASC, id ASC
             LIMIT ?`
        ).all(since, safeLimit + 1) as DbMessageRow[]
    }

    const hasMore = rows.length > safeLimit
    const resultRows = hasMore ? rows.slice(0, safeLimit) : rows
    const messages = resultRows.map(toStoredMessage)

    let nextCursor: string | null = null
    if (hasMore && resultRows.length > 0) {
        const last = resultRows[resultRows.length - 1]
        nextCursor = `${last.created_at}:${last.id}`
    }

    return { messages, cursor: nextCursor, hasMore }
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = getMaxSeq(db, fromSessionId)
    const newMaxSeq = getMaxSeq(db, toSessionId)

    try {
        db.exec('BEGIN')

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            db.prepare(
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
        }

        const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            db.prepare(
                `UPDATE messages SET local_id = NULL WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        const result = db.prepare(
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
