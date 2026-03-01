import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

import { AccessTokenStore } from './accessTokenStore'
import { ApiKeyStore } from './apiKeyStore'
import { CredentialStore } from './credentialStore'
import { safeJsonParse } from './json'
import { MachineStore } from './machineStore'
import { MessageStore } from './messageStore'
import { inferMessageRole } from './messages'
import { PreferenceStore } from './preferenceStore'
import { PushStore } from './pushStore'
import { SessionStore } from './sessionStore'
import { UserStore } from './userStore'

export type {
    Permission,
    StoredAccessToken,
    StoredApiKey,
    StoredCredential,
    StoredMachine,
    StoredMachineCredential,
    StoredMessage,
    StoredPushSubscription,
    StoredSession,
    StoredUser,
    VersionedUpdateResult
} from './types'
export { AccessTokenStore } from './accessTokenStore'
export { ApiKeyStore } from './apiKeyStore'
export { CredentialStore } from './credentialStore'
export { MachineStore } from './machineStore'
export { MessageStore } from './messageStore'
export { PreferenceStore } from './preferenceStore'
export { PushStore } from './pushStore'
export { SessionStore } from './sessionStore'
export { UserStore } from './userStore'

const SCHEMA_VERSION: number = 12
const REQUIRED_TABLES = [
    'sessions',
    'machines',
    'messages',
    'users',
    'push_subscriptions',
    'credentials',
    'machine_credentials',
    'api_keys',
    'access_tokens',
    'preferences'
] as const

export class Store {
    private db: Database
    private readonly dbPath: string

    readonly accessTokens: AccessTokenStore
    readonly apiKeys: ApiKeyStore
    readonly credentials: CredentialStore
    readonly sessions: SessionStore
    readonly machines: MachineStore
    readonly messages: MessageStore
    readonly users: UserStore
    readonly push: PushStore
    readonly preferences: PreferenceStore

    constructor(dbPath: string) {
        this.dbPath = dbPath
        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            const dir = dirname(dbPath)
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            try {
                chmodSync(dir, 0o700)
            } catch {
            }

            if (!existsSync(dbPath)) {
                try {
                    const fd = openSync(dbPath, 'a', 0o600)
                    closeSync(fd)
                } catch {
                }
            }
        }

        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec('PRAGMA foreign_keys = ON')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.initSchema()

        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    chmodSync(path, 0o600)
                } catch {
                }
            }
        }

        this.accessTokens = new AccessTokenStore(this.db)
        this.apiKeys = new ApiKeyStore(this.db)
        this.credentials = new CredentialStore(this.db)
        this.sessions = new SessionStore(this.db)
        this.machines = new MachineStore(this.db)
        this.messages = new MessageStore(this.db)
        this.users = new UserStore(this.db)
        this.push = new PushStore(this.db)
        this.preferences = new PreferenceStore(this.db)
    }

    private initSchema(): void {
        const currentVersion = this.getUserVersion()
        if (currentVersion === 0) {
            if (this.hasAnyUserTables()) {
                this.migrateLegacySchemaIfNeeded()
                this.createSchema()
                this.setUserVersion(SCHEMA_VERSION)
                return
            }

            this.createSchema()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 1) {
            this.migrateFromV1ToV2()
            this.setUserVersion(2)
            this.initSchema()
            return
        }

        if (currentVersion === 2) {
            this.migrateFromV2ToV3()
            this.setUserVersion(3)
            this.initSchema()
            return
        }

        if (currentVersion === 3) {
            this.migrateFromV3ToV4()
            this.setUserVersion(4)
            this.initSchema()
            return
        }

        if (currentVersion === 4) {
            this.migrateFromV4ToV5()
            this.setUserVersion(5)
            this.initSchema()
            return
        }

        if (currentVersion === 5) {
            this.migrateFromV5ToV6()
            this.setUserVersion(6)
            this.initSchema()
            return
        }

        if (currentVersion === 6) {
            this.migrateFromV6ToV7()
            this.setUserVersion(7)
            this.initSchema()
            return
        }

        if (currentVersion === 7) {
            this.migrateFromV7ToV8()
            this.setUserVersion(8)
            this.initSchema()
            return
        }

        if (currentVersion === 8) {
            this.migrateFromV8ToV9()
            this.setUserVersion(9)
            this.initSchema()
            return
        }

        if (currentVersion === 9) {
            this.migrateFromV9ToV10()
            this.setUserVersion(10)
            this.initSchema()
            return
        }

        if (currentVersion === 10) {
            this.migrateFromV10ToV11()
            this.setUserVersion(11)
            this.initSchema()
            return
        }

        if (currentVersion === 11) {
            this.migrateFromV11ToV12()
            this.setUserVersion(12)
            this.initSchema()
            return
        }

        if (currentVersion !== SCHEMA_VERSION) {
            throw this.buildSchemaMismatchError(currentVersion)
        }

        this.assertRequiredTablesPresent()
    }

    private createSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                namespace TEXT NOT NULL DEFAULT 'default',
                machine_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                agent_state TEXT,
                agent_state_version INTEGER DEFAULT 1,
                todos TEXT,
                todos_updated_at INTEGER,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0,
                ui_state TEXT,
                ui_state_updated_at INTEGER,
                share_token TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token) WHERE share_token IS NOT NULL;

            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                runner_state TEXT,
                runner_state_version INTEGER DEFAULT 1,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0,
                api_key_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                local_id TEXT,
                role TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE INDEX IF NOT EXISTS idx_messages_session_role_seq ON messages(session_id, role, seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
            USING fts5(session_id UNINDEXED, content, content='messages', content_rowid='rowid');
            CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, session_id, content) VALUES (new.rowid, new.session_id, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, session_id, content) VALUES ('delete', old.rowid, old.session_id, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, session_id, content) VALUES ('delete', old.rowid, old.session_id, old.content);
                INSERT INTO messages_fts(rowid, session_id, content) VALUES (new.rowid, new.session_id, new.content);
            END;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
            CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(namespace, endpoint)
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);

            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                name TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                config TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_credentials_namespace ON credentials(namespace);
            CREATE INDEX IF NOT EXISTS idx_credentials_agent_type ON credentials(namespace, agent_type);

            CREATE TABLE IF NOT EXISTS machine_credentials (
                machine_id TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
                applied_at INTEGER NOT NULL,
                PRIMARY KEY (machine_id, agent_type)
            );
            CREATE INDEX IF NOT EXISTS idx_machine_credentials_credential ON machine_credentials(credential_id);

            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                key_prefix TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                permissions TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                revoked_at INTEGER,
                last_used_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
            CREATE INDEX IF NOT EXISTS idx_api_keys_namespace ON api_keys(namespace);

            CREATE TABLE IF NOT EXISTS access_tokens (
                id TEXT PRIMARY KEY,
                api_key_id TEXT NOT NULL,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                token_prefix TEXT NOT NULL,
                namespace TEXT NOT NULL,
                permissions TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                revoked_at INTEGER,
                FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_access_tokens_api_key ON access_tokens(api_key_id);
            CREATE INDEX IF NOT EXISTS idx_access_tokens_token_hash ON access_tokens(token_hash);
            CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON access_tokens(expires_at);

            CREATE TABLE IF NOT EXISTS preferences (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, key)
            );
        `)
    }

    private migrateLegacySchemaIfNeeded(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            return
        }

        const hasDaemon = columns.has('daemon_state') || columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') || columns.has('runner_state_version')

        if (hasDaemon && hasRunner) {
            throw new Error('SQLite schema has both daemon_state and runner_state columns in machines; manual cleanup required.')
        }

        if (hasDaemon && !hasRunner) {
            this.migrateFromV1ToV2()
        }
    }

    private migrateFromV1ToV2(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            throw new Error('SQLite schema missing machines table for v1 to v2 migration.')
        }

        const hasDaemon = columns.has('daemon_state') && columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') && columns.has('runner_state_version')

        if (hasRunner && !hasDaemon) {
            return
        }

        if (!hasDaemon) {
            throw new Error('SQLite schema missing daemon_state columns for v1 to v2 migration.')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state TO runner_state')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state_version TO runner_state_version')
            this.db.exec('COMMIT')
            return
        } catch (error) {
            this.db.exec('ROLLBACK')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec(`
                CREATE TABLE machines_new (
                    id TEXT PRIMARY KEY,
                    namespace TEXT NOT NULL DEFAULT 'default',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    metadata TEXT,
                    metadata_version INTEGER DEFAULT 1,
                    runner_state TEXT,
                    runner_state_version INTEGER DEFAULT 1,
                    active INTEGER DEFAULT 0,
                    active_at INTEGER,
                    seq INTEGER DEFAULT 0
                );
            `)
            this.db.exec(`
                INSERT INTO machines_new (
                    id, namespace, created_at, updated_at,
                    metadata, metadata_version,
                    runner_state, runner_state_version,
                    active, active_at, seq
                )
                SELECT id, namespace, created_at, updated_at,
                       metadata, metadata_version,
                       daemon_state, daemon_state_version,
                       active, active_at, seq
                FROM machines;
            `)
            this.db.exec('DROP TABLE machines')
            this.db.exec('ALTER TABLE machines_new RENAME TO machines')
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace)')
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`SQLite schema migration v1->v2 failed: ${message}`)
        }
    }

    private migrateFromV2ToV3(): void {
        return
    }

    private migrateFromV3ToV4(): void {
        const columns = new Set(
            (this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
        )
        if (!columns.has('ui_state')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN ui_state TEXT')
        }
        if (!columns.has('ui_state_updated_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN ui_state_updated_at INTEGER')
        }
    }

    private migrateFromV4ToV5(): void {
        const columns = new Set(
            (this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((row) => row.name)
        )
        if (!columns.has('share_token')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN share_token TEXT')
            this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token) WHERE share_token IS NOT NULL')
        }
    }

    private migrateFromV5ToV6(): void {
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)')
    }

    private migrateFromV6ToV7(): void {
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
            USING fts5(session_id UNINDEXED, content, content='messages', content_rowid='rowid');
            CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, session_id, content) VALUES (new.rowid, new.session_id, new.content);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, session_id, content) VALUES ('delete', old.rowid, old.session_id, old.content);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, session_id, content) VALUES ('delete', old.rowid, old.session_id, old.content);
                INSERT INTO messages_fts(rowid, session_id, content) VALUES (new.rowid, new.session_id, new.content);
            END;
        `)

        this.db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`).run()
    }

    private migrateFromV7ToV8(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS credentials (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                name TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                config TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_credentials_namespace ON credentials(namespace);
            CREATE INDEX IF NOT EXISTS idx_credentials_agent_type ON credentials(namespace, agent_type);

            CREATE TABLE IF NOT EXISTS machine_credentials (
                machine_id TEXT NOT NULL,
                agent_type TEXT NOT NULL,
                credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
                applied_at INTEGER NOT NULL,
                PRIMARY KEY (machine_id, agent_type)
            );
            CREATE INDEX IF NOT EXISTS idx_machine_credentials_credential ON machine_credentials(credential_id);
        `)
    }

    private migrateFromV8ToV9(): void {
        const columns = this.getMessageColumnNames()
        if (!columns.has('role')) {
            this.db.exec('ALTER TABLE messages ADD COLUMN role TEXT')
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_role_seq ON messages(session_id, role, seq)')

        const selectStmt = this.db.prepare(`
            SELECT rowid, id, content
            FROM messages
            WHERE role IS NULL AND rowid > ?
            ORDER BY rowid ASC
            LIMIT 500
        `)
        const updateStmt = this.db.prepare('UPDATE messages SET role = ? WHERE id = ?')
        try {
            this.db.exec('BEGIN')
            let cursor = 0
            while (true) {
                const rows = selectStmt.all(cursor) as Array<{ rowid: number; id: string; content: string }>
                if (rows.length === 0) {
                    break
                }
                for (const row of rows) {
                    cursor = row.rowid
                    const parsed = safeJsonParse(row.content)
                    const role = inferMessageRole(parsed)
                    if (!role) {
                        continue
                    }
                    updateStmt.run(role, row.id)
                }
            }
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    private migrateFromV9ToV10(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                key_prefix TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                permissions TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                revoked_at INTEGER,
                last_used_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
            CREATE INDEX IF NOT EXISTS idx_api_keys_namespace ON api_keys(namespace);

            CREATE TABLE IF NOT EXISTS access_tokens (
                id TEXT PRIMARY KEY,
                api_key_id TEXT NOT NULL,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                token_prefix TEXT NOT NULL,
                namespace TEXT NOT NULL,
                permissions TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                revoked_at INTEGER,
                FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_access_tokens_api_key ON access_tokens(api_key_id);
            CREATE INDEX IF NOT EXISTS idx_access_tokens_token_hash ON access_tokens(token_hash);
            CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON access_tokens(expires_at);
        `)
    }

    private migrateFromV10ToV11(): void {
        this.db.exec(`
            ALTER TABLE machines ADD COLUMN api_key_id TEXT;
        `)
    }

    private migrateFromV11ToV12(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS preferences (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, key)
            );
        `)
    }

    private getMachineColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMessageColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getUserVersion(): number {
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
        return row?.user_version ?? 0
    }

    private setUserVersion(version: number): void {
        this.db.exec(`PRAGMA user_version = ${version}`)
    }

    private hasAnyUserTables(): boolean {
        const row = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
        ).get() as { name?: string } | undefined
        return Boolean(row?.name)
    }

    private assertRequiredTablesPresent(): void {
        const placeholders = REQUIRED_TABLES.map(() => '?').join(', ')
        const rows = this.db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
        ).all(...REQUIRED_TABLES) as Array<{ name: string }>
        const existing = new Set(rows.map((row) => row.name))
        const missing = REQUIRED_TABLES.filter((table) => !existing.has(table))

        if (missing.length > 0) {
            throw new Error(
                `SQLite schema is missing required tables (${missing.join(', ')}). ` +
                'Back up and rebuild the database, or run an offline migration to the expected schema version.'
            )
        }
    }

    private buildSchemaMismatchError(currentVersion: number): Error {
        const location = (this.dbPath === ':memory:' || this.dbPath.startsWith('file::memory:'))
            ? 'in-memory database'
            : this.dbPath
        return new Error(
            `SQLite schema version mismatch for ${location}. ` +
            `Expected ${SCHEMA_VERSION}, found ${currentVersion}. ` +
            'This build does not run compatibility migrations. ' +
            'Back up and rebuild the database, or run an offline migration to the expected schema version.'
        )
    }
}
