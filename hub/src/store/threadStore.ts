import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { ThreadTagsSchema, threadAuthorId, threadMemberId, type ThreadGuestLimits, type Thread, type ThreadInbox, type ThreadMember, type ThreadMessage, type ThreadReceipt, type ThreadSender } from '@hapi/protocol/threads'

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

export function createThreadMessageEdits(db: Database): void {
    db.exec(`
        ALTER TABLE thread_messages ADD COLUMN editedAt INTEGER;
        ALTER TABLE thread_messages ADD COLUMN recalledAt INTEGER;
        ALTER TABLE thread_guest_grants ADD COLUMN allowEdit INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE thread_message_revisions (
            messageId TEXT NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
            text TEXT NOT NULL, replacedAt INTEGER NOT NULL
        );
        CREATE INDEX thread_message_revisions_message ON thread_message_revisions(messageId);
    `)
}

export function createThreadGuestCodeReissue(db: Database): void {
    db.exec('ALTER TABLE thread_guest_grants ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0')
}

export function createThreadGuestGrants(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS thread_guest_grants (
            id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
            guestId TEXT NOT NULL UNIQUE, name TEXT NOT NULL, codeHash TEXT NOT NULL,
            visibleAfterSeq INTEGER NOT NULL, failedAttempts INTEGER NOT NULL DEFAULT 0,
            messagesPerMinute INTEGER NOT NULL, maxTextLength INTEGER NOT NULL,
            wakeLimit INTEGER NOT NULL, wakeCount INTEGER NOT NULL DEFAULT 0,
            createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS thread_guest_grants_thread ON thread_guest_grants(threadId);
    `)
}

/** An external guest's access to one thread: the guest is a member while the grant is usable. */
export type StoredThreadGuestGrant = Omit<ThreadGuestLimits, 'allowEdit'> & {
    allowEdit: boolean
    id: string
    threadId: string
    namespace: string
    guestId: string
    name: string
    codeHash: string
    visibleAfterSeq: number
    failedAttempts: number
    /** Bumped when the owner reissues the code, so tokens from the previous code stop working. */
    tokenVersion: number
    wakeCount: number
    createdAt: number
    expiresAt: number
    revokedAt: number | null
}

export const isThreadGuestGrantUsable = (grant: StoredThreadGuestGrant, now = Date.now()): boolean =>
    grant.revokedAt === null && grant.expiresAt > now

type ThreadRow = Omit<Thread, 'archived' | 'tags'> & { archived: number; tags: string; namespace: string; shareToken: string | null }
type MessageRow = Omit<ThreadMessage, 'sender' | 'mentions' | 'receipts' | 'replyTo' | 'editedAt' | 'recalledAt'> & { sender: string; mentions: string; replyTo: string | null; editedAt: number | null; recalledAt: number | null }
type GuestGrantRow = Omit<StoredThreadGuestGrant, 'allowEdit'> & { allowEdit: number }
const toGuestGrant = (row: GuestGrantRow): StoredThreadGuestGrant => ({ ...row, allowEdit: Boolean(row.allowEdit) })
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

    createGuestGrant(threadId: string, params: ThreadGuestLimits & { id: string; guestId: string; name: string; codeHash: string; includeHistory: boolean; expiresAt: number }): StoredThreadGuestGrant {
        this.db.transaction(() => {
            this.db.run('INSERT INTO thread_guest_grants(id, threadId, guestId, name, codeHash, visibleAfterSeq, messagesPerMinute, maxTextLength, wakeLimit, allowEdit, createdAt, expiresAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
                params.id, threadId, params.guestId, params.name, params.codeHash, params.includeHistory ? 0 : this.latestSeq(threadId),
                params.messagesPerMinute, params.maxTextLength, params.wakeLimit, Number(params.allowEdit), Date.now(), params.expiresAt
            ])
            this.add(threadId, { kind: 'guest', guestId: params.guestId, name: params.name })
        })()
        return this.guestGrant(params.id)!
    }

    guestGrant(id: string): StoredThreadGuestGrant | undefined {
        const row = this.db.query<GuestGrantRow, [string]>('SELECT gg.*, t.namespace FROM thread_guest_grants gg JOIN threads t ON t.id = gg.threadId WHERE gg.id = ?').get(id)
        return row ? toGuestGrant(row) : undefined
    }

    /** Unrevoked grants, expired ones included so that the owner can renew them. */
    guestGrants(threadId: string): StoredThreadGuestGrant[] {
        return this.db.query<GuestGrantRow, [string]>('SELECT gg.*, t.namespace FROM thread_guest_grants gg JOIN threads t ON t.id = gg.threadId WHERE gg.threadId = ? AND gg.revokedAt IS NULL ORDER BY gg.createdAt').all(threadId).map(toGuestGrant)
    }

    usableGuestGrants(threadId: string): StoredThreadGuestGrant[] {
        return this.db.query<GuestGrantRow, [string, number]>('SELECT gg.*, t.namespace FROM thread_guest_grants gg JOIN threads t ON t.id = gg.threadId WHERE gg.threadId = ? AND gg.revokedAt IS NULL AND gg.expiresAt > ? ORDER BY gg.createdAt').all(threadId, Date.now()).map(toGuestGrant)
    }

    /** New limits also reset the grant's wake budget. */
    setGuestLimits(threadId: string, id: string, limits: ThreadGuestLimits): boolean {
        return this.db.run('UPDATE thread_guest_grants SET messagesPerMinute = ?, maxTextLength = ?, wakeLimit = ?, allowEdit = ?, wakeCount = 0 WHERE id = ? AND threadId = ? AND revokedAt IS NULL', [
            limits.messagesPerMinute, limits.maxTextLength, limits.wakeLimit, Number(limits.allowEdit), id, threadId
        ]).changes > 0
    }

    /** Also revives an expired grant: its guest rejoins with the same identity and token. */
    renewGuestGrant(threadId: string, id: string, expiresAt: number): boolean {
        return this.db.run('UPDATE thread_guest_grants SET expiresAt = ? WHERE id = ? AND threadId = ? AND revokedAt IS NULL', [expiresAt, id, threadId]).changes > 0
    }

    reserveGuestWake(id: string): boolean {
        return this.db.run('UPDATE thread_guest_grants SET wakeCount = wakeCount + 1 WHERE id = ? AND wakeCount < wakeLimit', [id]).changes > 0
    }

    revokeGuestGrant(threadId: string, id: string): boolean {
        return this.db.transaction(() => {
            const grant = this.guestGrant(id)
            if (!grant || grant.threadId !== threadId || grant.revokedAt !== null) return false
            this.db.run('UPDATE thread_guest_grants SET revokedAt = ? WHERE id = ?', [Date.now(), id])
            this.leave(threadId, grant.guestId)
            return true
        })()
    }

    /** Consumes a single-use code; false when it is wrong or already redeemed. Concurrent redemptions cannot both win. */
    redeemGuestCode(id: string, codeHash: string): boolean {
        return this.db.run("UPDATE thread_guest_grants SET codeHash = '' WHERE id = ? AND codeHash = ? AND codeHash != ''", [id, codeHash]).changes > 0
    }

    /** Replaces the code of a usable grant and signs its guest out; the identity and history stay. */
    reissueGuestCode(threadId: string, id: string, codeHash: string): boolean {
        return this.db.run('UPDATE thread_guest_grants SET codeHash = ?, failedAttempts = 0, tokenVersion = tokenVersion + 1 WHERE id = ? AND threadId = ? AND revokedAt IS NULL AND expiresAt > ?', [
            codeHash, id, threadId, Date.now()
        ]).changes > 0
    }

    /** Counts a wrong code; the grant is revoked once `maxAttempts` is reached. */
    recordGuestFailedAttempt(id: string, maxAttempts: number): void {
        this.db.run('UPDATE thread_guest_grants SET failedAttempts = failedAttempts + 1 WHERE id = ? AND revokedAt IS NULL', [id])
        const grant = this.guestGrant(id)
        if (grant && grant.revokedAt === null && grant.failedAttempts >= maxAttempts) this.revokeGuestGrant(grant.threadId, id)
    }

    private hydrate(row: MessageRow): ThreadMessage {
        // A recall hides the content from every reader; the row keeps it.
        const recalled = row.recalledAt !== null
        return { ...row, text: recalled ? '' : row.text, sender: JSON.parse(row.sender), mentions: recalled ? [] : JSON.parse(row.mentions), replyTo: row.replyTo ?? undefined,
            editedAt: row.editedAt ?? undefined, recalledAt: row.recalledAt ?? undefined,
            receipts: this.db.query<ThreadReceipt, [string]>('SELECT memberId, deliveredAt, readAt, wakeStatus, reason FROM thread_receipts WHERE messageId = ?').all(row.id) }
    }

    message(id: string): ThreadMessage | undefined {
        const row = this.db.query<MessageRow, [string]>('SELECT * FROM thread_messages WHERE id = ?').get(id)
        return row ? this.hydrate(row) : undefined
    }

    send(threadId: string, sender: ThreadSender, input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }): { message: ThreadMessage; duplicate: boolean } {
        return this.db.transaction(() => {
            const senderId = threadAuthorId(sender)
            const existing = this.db.query<MessageRow, [string, string, string]>('SELECT * FROM thread_messages WHERE threadId = ? AND senderId = ? AND clientMessageId = ?').get(threadId, senderId, input.clientMessageId)
            if (existing) return { message: this.hydrate(existing), duplicate: true }
            const id = randomUUID()
            const seq = this.db.query<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM thread_messages WHERE threadId = ?').get(threadId)!.seq
            this.db.run('INSERT INTO thread_messages(id, threadId, seq, senderId, sender, text, mentions, replyTo, clientMessageId, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, threadId, seq, senderId, JSON.stringify(sender), input.text, JSON.stringify([...new Set(input.mentions)]), input.replyTo ?? null, input.clientMessageId, Date.now()])
            for (const member of this.members(threadId)) {
                if (member.id !== senderId) this.db.run('INSERT INTO thread_receipts(messageId, memberId) VALUES(?, ?)', [id, member.id])
            }
            if (sender.kind === 'user') this.db.run('UPDATE threads SET wakeCount = 0 WHERE id = ?', [threadId])
            if (sender.kind === 'user' && !sender.guest) this.db.run('UPDATE thread_guest_grants SET wakeCount = 0 WHERE threadId = ?', [threadId])
            return { message: this.message(id)!, duplicate: false }
        })()
    }

    /** Keeps the replaced text as a revision. */
    editMessage(id: string, text: string): void {
        this.db.transaction(() => {
            const now = Date.now()
            this.db.run('INSERT INTO thread_message_revisions(messageId, text, replacedAt) SELECT id, text, ? FROM thread_messages WHERE id = ? AND recalledAt IS NULL', [now, id])
            this.db.run('UPDATE thread_messages SET text = ?, editedAt = ? WHERE id = ? AND recalledAt IS NULL', [text, now, id])
        })()
    }

    /** A soft delete: content and receipts stay stored, but readers and inboxes no longer see them. */
    recallMessage(id: string): void {
        this.db.run('UPDATE thread_messages SET recalledAt = ? WHERE id = ? AND recalledAt IS NULL', [Date.now(), id])
    }

    history(threadId: string, after: number, before: number, limit: number, latest = false): ThreadMessage[] {
        const rows = this.db.query<MessageRow, [string, number, number, number]>(`SELECT * FROM thread_messages WHERE threadId = ? AND seq > ? AND seq < ? ORDER BY seq ${latest ? 'DESC' : 'ASC'} LIMIT ?`).all(threadId, after, before, limit)
        return (latest ? rows.reverse() : rows).map(row => this.hydrate(row))
    }

    inbox(namespace: string, memberId: string, options: { threadId?: string; mentions?: boolean; limit: number }): ThreadInbox {
        const rows = this.db.query<MessageRow, [string, string, string, string, number, string, number]>(`
            SELECT m.* FROM thread_messages m JOIN threads g ON g.id = m.threadId
            JOIN thread_receipts r ON r.messageId = m.id JOIN thread_members gm ON gm.threadId = g.id AND gm.id = r.memberId
            WHERE g.namespace = ? AND r.memberId = ? AND r.readAt IS NULL AND m.recalledAt IS NULL
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
        return this.db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM thread_receipts r JOIN thread_messages m ON m.id = r.messageId WHERE m.threadId = ? AND r.memberId = ? AND r.readAt IS NULL AND m.recalledAt IS NULL').get(threadId, memberId)!.n
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
        return this.db.query<{ messageId: string; memberId: string; threadId: string; namespace: string }, []>(`SELECT r.messageId, r.memberId, m.threadId, g.namespace FROM thread_receipts r JOIN thread_messages m ON m.id = r.messageId JOIN threads g ON g.id = m.threadId WHERE r.wakeStatus = 'queued' AND r.readAt IS NULL AND m.recalledAt IS NULL`).all()
    }
}
