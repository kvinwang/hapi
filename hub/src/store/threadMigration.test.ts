import { afterEach, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './index'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('migrates v26 groups in place without losing members, messages, read state, or wake budgets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-migration-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const sender = { kind: 'session' as const, sessionId: randomUUID() }
    const thread = original.threads.create('default', 'Existing discussion', 'Keep this', sender)
    original.threads.settings(thread.id, sender.sessionId, false)
    const message = original.threads.send(thread.id, { kind: 'user' }, { text: 'Existing message', mentions: [sender.sessionId], clientMessageId: randomUUID() }).message
    original.threads.consume(sender.sessionId, [message.id])
    original.threads.reserveWake(thread.id)
    const pending = original.threads.send(thread.id, { kind: 'user' }, { text: 'Unread mention', mentions: [sender.sessionId], clientMessageId: randomUUID() }).message
    original.threads.receipt(pending.id, sender.sessionId, 'queued', 'busy')
    original.threads.reserveWake(thread.id)
    const db = new Database(path)
    db.exec(`
        DROP INDEX idx_threads_share_token;
        ALTER TABLE threads DROP COLUMN shareToken;
        ALTER TABLE threads DROP COLUMN tags;
        ALTER TABLE threads RENAME TO groups;
        ALTER TABLE thread_members RENAME TO group_members;
        ALTER TABLE thread_messages RENAME TO group_messages;
        ALTER TABLE thread_receipts RENAME TO group_receipts;
        ALTER TABLE group_members RENAME COLUMN threadId TO groupId;
        ALTER TABLE group_messages RENAME COLUMN threadId TO groupId;
        DROP INDEX thread_receipts_unread;
        DROP INDEX thread_members_session;
        CREATE INDEX group_receipts_unread ON group_receipts(memberId, readAt);
        CREATE INDEX group_members_session ON group_members(id);
        PRAGMA user_version = 26;
    `)
    const migrated = new Store(path)
    expect(migrated.threads.get(thread.id, 'default')).toMatchObject({ id: thread.id, name: 'Existing discussion', wakeCount: 1 })
    expect(migrated.threads.members(thread.id)).toContainEqual(expect.objectContaining({ id: sender.sessionId, mentionWake: false }))
    expect(migrated.threads.message(message.id)).toMatchObject({ threadId: thread.id, text: 'Existing message' })
    expect(migrated.threads.message(message.id)!.receipts[0].readAt).not.toBeNull()
    expect(migrated.threads.inbox('default', sender.sessionId, { limit: 50 }).messages.map(item => item.id)).toEqual([pending.id])
    expect(migrated.threads.pending()).toContainEqual(expect.objectContaining({ messageId: pending.id, threadId: thread.id }))
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(29)
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'groups'").all()).toEqual([])
    expect(new Store(path).threads.members(thread.id)).toHaveLength(2)
    db.close()
})

it('creates thread tables when upgrading a v25 database with no groups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-v25-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    new Store(path)
    const db = new Database(path)
    db.exec('DROP TABLE thread_receipts; DROP TABLE thread_messages; DROP TABLE thread_members; DROP TABLE threads; PRAGMA user_version = 25;')
    expect(new Store(path).threads.list('default')).toEqual([])
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(29)
    db.close()
})

it('upgrades v27 threads with sharing disabled and preserves history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-v27-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const thread = original.threads.create('default', 'Private thread', '', { kind: 'user' })
    const message = original.threads.send(thread.id, { kind: 'user' }, { text: 'Existing history', mentions: [], clientMessageId: randomUUID() }).message
    const db = new Database(path)
    db.exec('DROP INDEX idx_threads_share_token; ALTER TABLE threads DROP COLUMN shareToken; ALTER TABLE threads DROP COLUMN tags; PRAGMA user_version = 27;')
    const migrated = new Store(path)
    expect(migrated.threads.getShareToken(thread.id, 'default')).toBeNull()
    expect(migrated.threads.message(message.id)?.text).toBe('Existing history')
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(29)
    db.close()
})

it('upgrades v28 threads with empty tags without losing sharing or history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-v28-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const thread = original.threads.create('default', 'Existing thread', '', { kind: 'user' })
    const token = original.threads.setShared(thread.id, 'default', true)
    const message = original.threads.send(thread.id, { kind: 'user' }, { text: 'Keep history', mentions: [], clientMessageId: randomUUID() }).message
    const db = new Database(path)
    db.exec('ALTER TABLE threads DROP COLUMN tags; PRAGMA user_version = 28;')
    const migrated = new Store(path)
    expect(migrated.threads.get(thread.id, 'default')?.tags).toEqual([])
    expect(migrated.threads.getShareToken(thread.id, 'default')).toBe(token)
    expect(migrated.threads.message(message.id)?.text).toBe('Keep history')
    migrated.threads.setTags(thread.id, 'default', ['release'])
    expect(new Store(path).threads.list('default')[0].tags).toEqual(['release'])
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(29)
    db.close()
})
