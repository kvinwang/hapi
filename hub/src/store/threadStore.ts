import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { ThreadTagsSchema, threadMemberId, type Thread, type ThreadInbox, type ThreadMember, type ThreadMessage, type ThreadReceipt, type ThreadSender } from '@hapi/protocol/threads'

export function createThreadTables(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY, namespace TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0, wakeCount INTEGER NOT NULL DEFAULT 0,
            wakeLimit INTEGER NOT NULL DEFAULT 20, createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS thread_members (
            threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            id TEXT NOT NULL, kind TEXT NOT NULL, mentionWake INTEGER NOT NULL DEFAULT 1,
            joinedAt INTEGER NOT NULL, PRIMARY KEY (threadId, id)
        );
        CREATE TABLE IF NOT EXISTS thread_messages (
            id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL, senderId TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
            mentions TEXT NOT NULL, replyTo TEXT, clientMessageId TEXT NOT NULL, createdAt INTEGER NOT NULL,
            UNIQUE(threadId, seq), UNIQUE(threadId, senderId, clientMessageId)
        );
        CREATE TABLE IF NOT EXISTS thread_receipts (
            messageId TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
            memberId TEXT NOT NULL, deliveredAt INTEGER, readAt INTEGER, wakeStatus TEXT, reason TEXT,
            PRIMARY KEY(messageId, memberId)
        );
        CREATE INDEX IF NOT EXISTS thread_receipts_unread ON thread_receipts(memberId, readAt);
        CREATE INDEX IF NOT EXISTS thread_members_session ON thread_members(id);
    `)
}
export function createThreadSharing(db: Database): void {
    db.exec(`
        ALTER TABLE threads ADD COLUMN shareToken TEXT;
        CREATE UNIQUE INDEX idx_threads_share_token ON threads(shareToken) WHERE shareToken IS NOT NULL;
    `)
}

export function createThreadTags(db: Database): void {
    db.exec("ALTER TABLE threads ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
}

type ThreadRow = Omit<Thread, 'archived' | 'tags'> & { archived: number; tags: string; namespace: string; shareToken: string | null }
type MessageRow = Omit<ThreadMessage, 'sender' | 'mentions' | 'receipts' | 'replyTo'> & { sender: string; mentions: string; replyTo: string | null }
type MemberRow = Omit<ThreadMember, 'mentionWake'> & { mentionWake: number }

function toThread(row: ThreadRow): Thread {
    return { id: row.id, name: row.name, description: row.description, tags: ThreadTagsSchema.parse(JSON.parse(row.tags)), archived: Boolean(row.archived), wakeCount: row.wakeCount, wakeLimit: row.wakeLimit, createdAt: row.createdAt }
}

export class ThreadStore {
    constructor(private readonly db: Database) {}

    get(id: string, namespace: string): Thread | undefined {
        const row = this.db.query<ThreadRow, [string, string]>('SELECT * FROM threads WHERE id = ? AND namespace = ?').get(id, namespace)
        return row ? toThread(row) : undefined
    }

    list(namespace: string, memberId?: string): Thread[] {
        const rows = memberId
            ? this.db.query<ThreadRow, [string, string]>('SELECT g.* FROM threads g JOIN thread_members m ON m.threadId = g.id WHERE g.namespace = ? AND m.id = ? ORDER BY g.createdAt').all(namespace, memberId)
            : this.db.query<ThreadRow, [string]>('SELECT * FROM threads WHERE namespace = ? ORDER BY createdAt').all(namespace)
        return rows.map(toThread)
    }

    getShareToken(id: string, namespace: string): string | null {
        return this.db.query<{ shareToken: string | null }, [string, string]>('SELECT shareToken FROM threads WHERE id = ? AND namespace = ?').get(id, namespace)?.shareToken ?? null
    }

    setShared(id: string, namespace: string, enabled: boolean): string | null {
        if (enabled) this.db.run('UPDATE threads SET shareToken = COALESCE(shareToken, ?) WHERE id = ? AND namespace = ?', [randomUUID(), id, namespace])
        else this.db.run('UPDATE threads SET shareToken = NULL WHERE id = ? AND namespace = ?', [id, namespace])
        return this.getShareToken(id, namespace)
    }

    getShared(token: string): { thread: Thread; namespace: string } | undefined {
        const row = this.db.query<ThreadRow, [string]>('SELECT * FROM threads WHERE shareToken = ?').get(token)
        return row ? { thread: toThread(row), namespace: row.namespace } : undefined
    }

    create(namespace: string, name: string, description: string, sender: ThreadSender, tags: string[] = []): Thread {
        return this.db.transaction(() => {
            const id = randomUUID()
            this.db.run('INSERT INTO threads(id, namespace, name, description, tags, createdAt) VALUES(?, ?, ?, ?, ?, ?)', [id, namespace, name, description, JSON.stringify(ThreadTagsSchema.parse(tags)), Date.now()])
            this.add(id, { kind: 'user' })
            this.add(id, sender)
            return this.get(id, namespace)!
        })()
    }

    setTags(id: string, namespace: string, tags: string[]): void {
        this.db.run('UPDATE threads SET tags = ? WHERE id = ? AND namespace = ?', [
            JSON.stringify(ThreadTagsSchema.parse(tags)), id, namespace
        ])
    }

    members(threadId: string): ThreadMember[] {
        return this.db.query<MemberRow, [string]>('SELECT * FROM thread_members WHERE threadId = ? ORDER BY joinedAt, id').all(threadId)
            .map(row => ({ ...row, mentionWake: Boolean(row.mentionWake) }))
    }

    add(threadId: string, sender: ThreadSender): void {
        this.db.run('INSERT OR IGNORE INTO thread_members(threadId, id, kind, joinedAt) VALUES(?, ?, ?, ?)', [threadId, threadMemberId(sender), sender.kind, Date.now()])
    }

    leave(threadId: string, memberId: string): void {
        this.db.transaction(() => {
            this.db.run('DELETE FROM thread_receipts WHERE memberId = ? AND messageId IN (SELECT id FROM thread_messages WHERE threadId = ?) AND readAt IS NULL', [memberId, threadId])
            this.db.run('DELETE FROM thread_members WHERE threadId = ? AND id = ?', [threadId, memberId])
        })()
    }

    settings(threadId: string, memberId: string, mentionWake: boolean): void {
        this.db.run('UPDATE thread_members SET mentionWake = ? WHERE threadId = ? AND id = ?', [Number(mentionWake), threadId, memberId])
    }

    archive(threadId: string): void {
        this.db.run('UPDATE threads SET archived = 1 WHERE id = ?', [threadId])
        this.db.run("UPDATE thread_receipts SET wakeStatus = 'not-woken', reason = 'inactive' WHERE wakeStatus = 'queued' AND messageId IN (SELECT id FROM thread_messages WHERE threadId = ?)", [threadId])
    }

    restore(threadId: string): void {
        this.db.run('UPDATE threads SET archived = 0 WHERE id = ?', [threadId])
    }

    inherit(source: string, target: string, namespace: string): void {
        this.db.transaction(() => {
            for (const thread of this.list(namespace, source).filter(g => !g.archived)) {
                this.add(thread.id, { kind: 'session', sessionId: target })
                const member = this.members(thread.id).find(m => m.id === source)!
                this.settings(thread.id, target, member.mentionWake)
                this.db.run(`INSERT OR IGNORE INTO thread_receipts(messageId, memberId, readAt)
                    SELECT r.messageId, ?, r.readAt FROM thread_receipts r JOIN thread_messages m ON m.id = r.messageId WHERE r.memberId = ? AND m.threadId = ?`, [target, source, thread.id])
            }
        })()
    }

    private hydrate(row: MessageRow): ThreadMessage {
        return { ...row, sender: JSON.parse(row.sender), mentions: JSON.parse(row.mentions), replyTo: row.replyTo ?? undefined,
            receipts: this.db.query<ThreadReceipt, [string]>('SELECT memberId, deliveredAt, readAt, wakeStatus, reason FROM thread_receipts WHERE messageId = ?').all(row.id) }
    }

    message(id: string): ThreadMessage | undefined {
        const row = this.db.query<MessageRow, [string]>('SELECT * FROM thread_messages WHERE id = ?').get(id)
        return row ? this.hydrate(row) : undefined
    }

    send(threadId: string, sender: ThreadSender, input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }): { message: ThreadMessage; duplicate: boolean } {
        return this.db.transaction(() => {
            const senderId = threadMemberId(sender)
            const existing = this.db.query<MessageRow, [string, string, string]>('SELECT * FROM thread_messages WHERE threadId = ? AND senderId = ? AND clientMessageId = ?').get(threadId, senderId, input.clientMessageId)
            if (existing) return { message: this.hydrate(existing), duplicate: true }
            const id = randomUUID()
            const seq = this.db.query<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM thread_messages WHERE threadId = ?').get(threadId)!.seq
            this.db.run('INSERT INTO thread_messages VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, threadId, seq, senderId, JSON.stringify(sender), input.text, JSON.stringify([...new Set(input.mentions)]), input.replyTo ?? null, input.clientMessageId, Date.now()])
            for (const member of this.members(threadId)) {
                if (member.id !== senderId) this.db.run('INSERT INTO thread_receipts(messageId, memberId) VALUES(?, ?)', [id, member.id])
            }
            if (sender.kind === 'user') this.db.run('UPDATE threads SET wakeCount = 0 WHERE id = ?', [threadId])
            return { message: this.message(id)!, duplicate: false }
        })()
    }

    history(threadId: string, after: number, before: number, limit: number, latest = false): ThreadMessage[] {
        const rows = this.db.query<MessageRow, [string, number, number, number]>(`SELECT * FROM thread_messages WHERE threadId = ? AND seq > ? AND seq < ? ORDER BY seq ${latest ? 'DESC' : 'ASC'} LIMIT ?`).all(threadId, after, before, limit)
        return (latest ? rows.reverse() : rows).map(row => this.hydrate(row))
    }

    inbox(namespace: string, memberId: string, options: { threadId?: string; mentions?: boolean; limit: number }): ThreadInbox {
        const rows = this.db.query<MessageRow, [string, string, string, string, number, string, number]>(`
            SELECT m.* FROM thread_messages m JOIN threads g ON g.id = m.threadId
            JOIN thread_receipts r ON r.messageId = m.id JOIN thread_members gm ON gm.threadId = g.id AND gm.id = r.memberId
            WHERE g.namespace = ? AND r.memberId = ? AND r.readAt IS NULL
            AND (? = '' OR g.id = ?) AND (? = 0 OR EXISTS(SELECT 1 FROM json_each(m.mentions) WHERE value = ?))
            ORDER BY m.createdAt, m.threadId, m.seq LIMIT ?
        `).all(namespace, memberId, options.threadId ?? '', options.threadId ?? '', Number(options.mentions ?? false), memberId, options.limit + 1)
        const messages: ThreadMessage[] = []
        let bytes = 0
        for (const row of rows.slice(0, options.limit)) {
            const message = this.hydrate(row)
            const size = Buffer.byteLength(JSON.stringify(message))
            if (messages.length && bytes + size > 64_000) break
            messages.push(message)
            bytes += size
        }
        return { messages, hasMore: rows.length > messages.length }
    }

    latestSeq(threadId: string, excludeSender = ''): number {
        return this.db.query<{ seq: number }, [string, string]>('SELECT COALESCE(MAX(seq), 0) AS seq FROM thread_messages WHERE threadId = ? AND senderId != ?').get(threadId, excludeSender)!.seq
    }

    unread(threadId: string, memberId: string): number {
        return this.db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM thread_receipts r JOIN thread_messages m ON m.id = r.messageId WHERE m.threadId = ? AND r.memberId = ? AND r.readAt IS NULL').get(threadId, memberId)!.n
    }

    consume(memberId: string, ids: string[]): void {
        this.db.transaction(() => {
            for (const id of ids) this.db.run('UPDATE thread_receipts SET readAt = COALESCE(readAt, ?) WHERE messageId = ? AND memberId = ?', [Date.now(), id, memberId])
        })()
    }

    receipt(messageId: string, memberId: string, status: ThreadReceipt['wakeStatus'], reason: ThreadReceipt['reason']): void {
        this.db.run('UPDATE thread_receipts SET wakeStatus = ?, reason = ?, deliveredAt = CASE WHEN ? = \'woken\' THEN COALESCE(deliveredAt, ?) ELSE deliveredAt END WHERE messageId = ? AND memberId = ?', [status, reason, status, Date.now(), messageId, memberId])
    }

    reserveWake(threadId: string): boolean {
        return this.db.run('UPDATE threads SET wakeCount = wakeCount + 1 WHERE id = ? AND archived = 0 AND wakeCount < wakeLimit', [threadId]).changes > 0
    }

    pending(): Array<{ messageId: string; memberId: string; threadId: string; namespace: string }> {
        return this.db.query<{ messageId: string; memberId: string; threadId: string; namespace: string }, []>(`SELECT r.messageId, r.memberId, m.threadId, g.namespace FROM thread_receipts r JOIN thread_messages m ON m.id = r.messageId JOIN threads g ON g.id = m.threadId WHERE r.wakeStatus = 'queued' AND r.readAt IS NULL`).all()
    }
}
