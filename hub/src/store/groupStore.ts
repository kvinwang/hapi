import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { groupMemberId, type Group, type GroupInbox, type GroupMember, type GroupMessage, type GroupReceipt, type GroupSender } from '@hapi/protocol/groups'

export function createGroupTables(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY, namespace TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0, wakeCount INTEGER NOT NULL DEFAULT 0,
            wakeLimit INTEGER NOT NULL DEFAULT 20, createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS group_members (
            groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            id TEXT NOT NULL, kind TEXT NOT NULL, mentionWake INTEGER NOT NULL DEFAULT 1,
            joinedAt INTEGER NOT NULL, PRIMARY KEY (groupId, id)
        );
        CREATE TABLE IF NOT EXISTS group_messages (
            id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL, senderId TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
            mentions TEXT NOT NULL, replyTo TEXT, clientMessageId TEXT NOT NULL, createdAt INTEGER NOT NULL,
            UNIQUE(groupId, seq), UNIQUE(groupId, senderId, clientMessageId)
        );
        CREATE TABLE IF NOT EXISTS group_receipts (
            messageId TEXT NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
            memberId TEXT NOT NULL, deliveredAt INTEGER, readAt INTEGER, wakeStatus TEXT, reason TEXT,
            PRIMARY KEY(messageId, memberId)
        );
        CREATE INDEX IF NOT EXISTS group_receipts_unread ON group_receipts(memberId, readAt);
        CREATE INDEX IF NOT EXISTS group_members_session ON group_members(id);
    `)
}
type GroupRow = Omit<Group, 'archived'> & { archived: number; namespace: string }
type MessageRow = Omit<GroupMessage, 'sender' | 'mentions' | 'receipts' | 'replyTo'> & { sender: string; mentions: string; replyTo: string | null }
type MemberRow = Omit<GroupMember, 'mentionWake'> & { mentionWake: number }

export class GroupStore {
    constructor(private readonly db: Database) {}

    get(id: string, namespace: string): Group | undefined {
        const row = this.db.query<GroupRow, [string, string]>('SELECT * FROM groups WHERE id = ? AND namespace = ?').get(id, namespace)
        return row ? { ...row, archived: Boolean(row.archived) } : undefined
    }

    list(namespace: string, memberId?: string): Group[] {
        const rows = memberId
            ? this.db.query<GroupRow, [string, string]>('SELECT g.* FROM groups g JOIN group_members m ON m.groupId = g.id WHERE g.namespace = ? AND m.id = ? ORDER BY g.createdAt').all(namespace, memberId)
            : this.db.query<GroupRow, [string]>('SELECT * FROM groups WHERE namespace = ? ORDER BY createdAt').all(namespace)
        return rows.map(row => ({ ...row, archived: Boolean(row.archived) }))
    }

    create(namespace: string, name: string, description: string, sender: GroupSender): Group {
        return this.db.transaction(() => {
            const id = randomUUID()
            this.db.run('INSERT INTO groups(id, namespace, name, description, createdAt) VALUES(?, ?, ?, ?, ?)', [id, namespace, name, description, Date.now()])
            this.add(id, { kind: 'user' })
            this.add(id, sender)
            return this.get(id, namespace)!
        })()
    }

    members(groupId: string): GroupMember[] {
        return this.db.query<MemberRow, [string]>('SELECT * FROM group_members WHERE groupId = ? ORDER BY joinedAt, id').all(groupId)
            .map(row => ({ ...row, mentionWake: Boolean(row.mentionWake) }))
    }

    add(groupId: string, sender: GroupSender): void {
        this.db.run('INSERT OR IGNORE INTO group_members(groupId, id, kind, joinedAt) VALUES(?, ?, ?, ?)', [groupId, groupMemberId(sender), sender.kind, Date.now()])
    }

    leave(groupId: string, memberId: string): void {
        this.db.transaction(() => {
            this.db.run('DELETE FROM group_receipts WHERE memberId = ? AND messageId IN (SELECT id FROM group_messages WHERE groupId = ?) AND readAt IS NULL', [memberId, groupId])
            this.db.run('DELETE FROM group_members WHERE groupId = ? AND id = ?', [groupId, memberId])
        })()
    }

    settings(groupId: string, memberId: string, mentionWake: boolean): void {
        this.db.run('UPDATE group_members SET mentionWake = ? WHERE groupId = ? AND id = ?', [Number(mentionWake), groupId, memberId])
    }

    archive(groupId: string): void {
        this.db.run('UPDATE groups SET archived = 1 WHERE id = ?', [groupId])
        this.db.run("UPDATE group_receipts SET wakeStatus = 'not-woken', reason = 'inactive' WHERE wakeStatus = 'queued' AND messageId IN (SELECT id FROM group_messages WHERE groupId = ?)", [groupId])
    }

    inherit(source: string, target: string, namespace: string): void {
        this.db.transaction(() => {
            for (const group of this.list(namespace, source).filter(g => !g.archived)) {
                this.add(group.id, { kind: 'session', sessionId: target })
                const member = this.members(group.id).find(m => m.id === source)!
                this.settings(group.id, target, member.mentionWake)
                this.db.run(`INSERT OR IGNORE INTO group_receipts(messageId, memberId, readAt)
                    SELECT r.messageId, ?, r.readAt FROM group_receipts r JOIN group_messages m ON m.id = r.messageId WHERE r.memberId = ? AND m.groupId = ?`, [target, source, group.id])
            }
        })()
    }

    private hydrate(row: MessageRow): GroupMessage {
        return { ...row, sender: JSON.parse(row.sender), mentions: JSON.parse(row.mentions), replyTo: row.replyTo ?? undefined,
            receipts: this.db.query<GroupReceipt, [string]>('SELECT memberId, deliveredAt, readAt, wakeStatus, reason FROM group_receipts WHERE messageId = ?').all(row.id) }
    }

    message(id: string): GroupMessage | undefined {
        const row = this.db.query<MessageRow, [string]>('SELECT * FROM group_messages WHERE id = ?').get(id)
        return row ? this.hydrate(row) : undefined
    }

    send(groupId: string, sender: GroupSender, input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }): { message: GroupMessage; duplicate: boolean } {
        return this.db.transaction(() => {
            const senderId = groupMemberId(sender)
            const existing = this.db.query<MessageRow, [string, string, string]>('SELECT * FROM group_messages WHERE groupId = ? AND senderId = ? AND clientMessageId = ?').get(groupId, senderId, input.clientMessageId)
            if (existing) return { message: this.hydrate(existing), duplicate: true }
            const id = randomUUID()
            const seq = this.db.query<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM group_messages WHERE groupId = ?').get(groupId)!.seq
            this.db.run('INSERT INTO group_messages VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, groupId, seq, senderId, JSON.stringify(sender), input.text, JSON.stringify([...new Set(input.mentions)]), input.replyTo ?? null, input.clientMessageId, Date.now()])
            for (const member of this.members(groupId)) {
                if (member.id !== senderId) this.db.run('INSERT INTO group_receipts(messageId, memberId) VALUES(?, ?)', [id, member.id])
            }
            if (sender.kind === 'user') this.db.run('UPDATE groups SET wakeCount = 0 WHERE id = ?', [groupId])
            return { message: this.message(id)!, duplicate: false }
        })()
    }

    history(groupId: string, after: number, before: number, limit: number, latest = false): GroupMessage[] {
        const rows = this.db.query<MessageRow, [string, number, number, number]>(`SELECT * FROM group_messages WHERE groupId = ? AND seq > ? AND seq < ? ORDER BY seq ${latest ? 'DESC' : 'ASC'} LIMIT ?`).all(groupId, after, before, limit)
        return (latest ? rows.reverse() : rows).map(row => this.hydrate(row))
    }

    inbox(namespace: string, memberId: string, options: { groupId?: string; mentions?: boolean; limit: number }): GroupInbox {
        const rows = this.db.query<MessageRow, [string, string, string, string, number, string, number]>(`
            SELECT m.* FROM group_messages m JOIN groups g ON g.id = m.groupId
            JOIN group_receipts r ON r.messageId = m.id JOIN group_members gm ON gm.groupId = g.id AND gm.id = r.memberId
            WHERE g.namespace = ? AND r.memberId = ? AND r.readAt IS NULL
            AND (? = '' OR g.id = ?) AND (? = 0 OR EXISTS(SELECT 1 FROM json_each(m.mentions) WHERE value = ?))
            ORDER BY m.createdAt, m.groupId, m.seq LIMIT ?
        `).all(namespace, memberId, options.groupId ?? '', options.groupId ?? '', Number(options.mentions ?? false), memberId, options.limit + 1)
        const messages: GroupMessage[] = []
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

    latestSeq(groupId: string, excludeSender = ''): number {
        return this.db.query<{ seq: number }, [string, string]>('SELECT COALESCE(MAX(seq), 0) AS seq FROM group_messages WHERE groupId = ? AND senderId != ?').get(groupId, excludeSender)!.seq
    }

    unread(groupId: string, memberId: string): number {
        return this.db.query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM group_receipts r JOIN group_messages m ON m.id = r.messageId WHERE m.groupId = ? AND r.memberId = ? AND r.readAt IS NULL').get(groupId, memberId)!.n
    }

    consume(memberId: string, ids: string[]): void {
        this.db.transaction(() => {
            for (const id of ids) this.db.run('UPDATE group_receipts SET readAt = COALESCE(readAt, ?) WHERE messageId = ? AND memberId = ?', [Date.now(), id, memberId])
        })()
    }

    receipt(messageId: string, memberId: string, status: GroupReceipt['wakeStatus'], reason: GroupReceipt['reason']): void {
        this.db.run('UPDATE group_receipts SET wakeStatus = ?, reason = ?, deliveredAt = CASE WHEN ? = \'woken\' THEN COALESCE(deliveredAt, ?) ELSE deliveredAt END WHERE messageId = ? AND memberId = ?', [status, reason, status, Date.now(), messageId, memberId])
    }

    reserveWake(groupId: string): boolean {
        return this.db.run('UPDATE groups SET wakeCount = wakeCount + 1 WHERE id = ? AND archived = 0 AND wakeCount < wakeLimit', [groupId]).changes > 0
    }

    pending(): Array<{ messageId: string; memberId: string; groupId: string; namespace: string }> {
        return this.db.query<{ messageId: string; memberId: string; groupId: string; namespace: string }, []>(`SELECT r.messageId, r.memberId, m.groupId, g.namespace FROM group_receipts r JOIN group_messages m ON m.id = r.messageId JOIN groups g ON g.id = m.groupId WHERE r.wakeStatus = 'queued' AND r.readAt IS NULL`).all()
    }
}
