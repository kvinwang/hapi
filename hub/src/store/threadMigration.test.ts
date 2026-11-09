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
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; DROP TABLE thread_guest_grants; ALTER TABLE session_grants DROP COLUMN allow_agents; ALTER TABLE session_grants DROP COLUMN thread_ids;')
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
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
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
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; DROP TABLE thread_guest_grants; ALTER TABLE session_grants DROP COLUMN allow_agents; ALTER TABLE session_grants DROP COLUMN thread_ids;')
    db.exec('DROP TABLE thread_receipts; DROP TABLE thread_messages; DROP TABLE thread_members; DROP TABLE threads; PRAGMA user_version = 25;')
    expect(new Store(path).threads.list('default')).toEqual([])
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
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
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; DROP TABLE thread_guest_grants; ALTER TABLE session_grants DROP COLUMN allow_agents; ALTER TABLE session_grants DROP COLUMN thread_ids;')
    db.exec('DROP INDEX idx_threads_share_token; ALTER TABLE threads DROP COLUMN shareToken; ALTER TABLE threads DROP COLUMN tags; PRAGMA user_version = 27;')
    const migrated = new Store(path)
    expect(migrated.threads.getShareToken(thread.id, 'default')).toBeNull()
    expect(migrated.threads.message(message.id)?.text).toBe('Existing history')
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
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
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; DROP TABLE thread_guest_grants; ALTER TABLE session_grants DROP COLUMN allow_agents; ALTER TABLE session_grants DROP COLUMN thread_ids;')
    db.exec('ALTER TABLE threads DROP COLUMN tags; PRAGMA user_version = 28;')
    const migrated = new Store(path)
    expect(migrated.threads.get(thread.id, 'default')?.tags).toEqual([])
    expect(migrated.threads.getShareToken(thread.id, 'default')).toBe(token)
    expect(migrated.threads.message(message.id)?.text).toBe('Keep history')
    migrated.threads.setTags(thread.id, 'default', ['release'])
    expect(new Store(path).threads.list('default')[0].tags).toEqual(['release'])
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
    db.close()
})

it('upgrades old guest codes with all new scopes disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-guest-v29-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const session = original.sessions.createSession({ tag: 'guest-root', namespace: 'default', metadata: { path: '/w' } })
    original.sessionGrants.create({ id: 'existing-code', sessionId: session.id, namespace: 'default', codeHash: 'test-hash', description: 'Existing access', allowVoice: true, expiresAt: Date.now() + 3600000 })
    const db = new Database(path)
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; DROP TABLE thread_guest_grants; ALTER TABLE session_grants DROP COLUMN allow_agents; ALTER TABLE session_grants DROP COLUMN thread_ids; PRAGMA user_version = 29;')
    const migrated = new Store(path)
    expect(migrated.sessionGrants.get('existing-code')).toMatchObject({ sessionId: session.id, allowVoice: true, allowAgents: false, threadIds: [], description: 'Existing access' })
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
    db.close()
})
it('adds thread guest grants when upgrading v30 without touching threads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-v30-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const thread = new Store(path).threads.create('default', 'Existing thread', '', { kind: 'user' })
    const db = new Database(path)
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; DROP TABLE thread_guest_grants; PRAGMA user_version = 30;')
    const migrated = new Store(path)
    expect(migrated.threads.get(thread.id, 'default')?.name).toBe('Existing thread')
    expect(migrated.threads.usableGuestGrants(thread.id)).toEqual([])
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
    db.close()
})
it('adds message edit and recall state when upgrading v31', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-v31-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const thread = original.threads.create('default', 'Existing thread', '', { kind: 'user' })
    const message = original.threads.send(thread.id, { kind: 'user' }, { text: 'Keep me', mentions: [], clientMessageId: randomUUID() }).message
    const db = new Database(path)
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('ALTER TABLE thread_guest_grants DROP COLUMN tokenVersion; DROP TABLE thread_message_revisions; ALTER TABLE thread_messages DROP COLUMN editedAt; ALTER TABLE thread_messages DROP COLUMN recalledAt; ALTER TABLE thread_guest_grants DROP COLUMN allowEdit; PRAGMA user_version = 31;')
    const migrated = new Store(path)
    expect(migrated.threads.message(message.id)).toMatchObject({ text: 'Keep me', editedAt: undefined, recalledAt: undefined })
    migrated.threads.editMessage(message.id, 'Edited')
    expect(db.query<{ text: string }, [string]>('SELECT text FROM thread_message_revisions WHERE messageId = ?').all(message.id)).toEqual([{ text: 'Keep me' }])
    migrated.threads.recallMessage(message.id)
    expect(migrated.threads.message(message.id)).toMatchObject({ text: '', recalledAt: expect.any(Number) })
    expect(db.query<{ text: string }, [string]>('SELECT text FROM thread_messages WHERE id = ?').get(message.id)?.text).toBe('Edited')
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
    db.close()
})
it('adds guest token versions when upgrading v32, keeping existing grants valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-thread-v32-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const thread = original.threads.create('default', 'Existing thread', '', { kind: 'user' })
    original.threads.createGuestGrant(thread.id, { id: 'grant', guestId: randomUUID(), name: 'Guest', codeHash: 'hash', includeHistory: false, messagesPerMinute: 10, maxTextLength: 100, wakeLimit: 1, allowEdit: false, expiresAt: Date.now() + 3600_000 })
    const db = new Database(path)
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version')
    db.exec('ALTER TABLE thread_guest_grants DROP COLUMN tokenVersion; PRAGMA user_version = 32;')
    expect(new Store(path).threads.guestGrant('grant')).toMatchObject({ name: 'Guest', tokenVersion: 0 })
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
    db.close()
})
it('adds session guest token versions when upgrading v33, keeping existing grants valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-guest-v33-'))
    directories.push(dir)
    const path = join(dir, 'test.db')
    const original = new Store(path)
    const session = original.sessions.createSession({ tag: 'guest-root', namespace: 'default', metadata: { path: '/w' } })
    original.sessionGrants.create({ id: 'existing-code', sessionId: session.id, namespace: 'default', codeHash: 'test-hash', description: null, allowVoice: false, expiresAt: Date.now() + 3600000 })
    const db = new Database(path)
    db.exec('ALTER TABLE session_grants DROP COLUMN token_version; PRAGMA user_version = 33;')
    expect(new Store(path).sessionGrants.get('existing-code')).toMatchObject({ codeHash: 'test-hash', tokenVersion: 0 })
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(34)
    db.close()
})
