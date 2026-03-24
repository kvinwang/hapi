use crate::types::{DecryptedMessage, Machine, Session};
use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{path::Path, sync::Arc};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 16;
const REQUIRED_TABLES: &[&str] = &[
    "sessions",
    "machines",
    "messages",
    "users",
    "push_subscriptions",
    "credentials",
    "machine_credentials",
    "api_keys",
    "access_tokens",
    "preferences",
    "lobstear_devices",
    "invites",
];

#[derive(Debug, Clone)]
pub struct StoredApiKey {
    pub id: String,
    pub name: String,
    pub key_hash: String,
    pub key_prefix: String,
    pub namespace: String,
    pub permissions: Vec<String>,
    pub created_at: i64,
    pub revoked_at: Option<i64>,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct StoredAccessToken {
    pub id: String,
    pub api_key_id: String,
    pub name: String,
    pub token_hash: String,
    pub token_prefix: String,
    pub namespace: String,
    pub permissions: Vec<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StoredCredential {
    pub id: String,
    pub namespace: String,
    pub name: String,
    #[serde(rename = "agentType")]
    pub agent_type: String,
    pub config: Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct StoredInvite {
    pub id: String,
    pub code: String,
    pub namespace: String,
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub redeemed_at: Option<i64>,
    pub redeemed_by: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredUser {
    pub id: i64,
    pub platform: String,
    pub platform_user_id: String,
    pub namespace: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StoredPushSubscription {
    pub id: i64,
    pub namespace: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StoredLobstearDevice {
    pub id: String,
    pub name: String,
    pub namespace: String,
    #[serde(rename = "bridgedSessionId")]
    pub bridged_session_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncMessageRow {
    pub id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: i64,
    pub content: Value,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct MessagesSinceResult {
    pub messages: Vec<SyncMessageRow>,
    pub cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn =
            Connection::open(path).with_context(|| format!("open sqlite: {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "busy_timeout", 5000i64)?;
        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();
        let current_version = self.get_user_version(&conn)?;
        if current_version == 0 {
            if self.has_any_user_tables(&conn)? {
                self.migrate_legacy_schema_if_needed(&conn)?;
                self.repair_schema_to_v16(&conn)?;
                self.create_schema(&conn)?;
                self.ensure_runtime_session_columns(&conn)?;
                self.set_user_version(&conn, SCHEMA_VERSION)?;
                self.assert_required_tables_present(&conn)?;
                return Ok(());
            }

            self.create_schema(&conn)?;
            self.ensure_runtime_session_columns(&conn)?;
            self.set_user_version(&conn, SCHEMA_VERSION)?;
            self.assert_required_tables_present(&conn)?;
            return Ok(());
        }

        let mut version = current_version;
        while version < SCHEMA_VERSION {
            match version {
                1 => self.migrate_from_v1_to_v2(&conn)?,
                2 => self.migrate_from_v2_to_v3(),
                3 => self.migrate_from_v3_to_v4(&conn)?,
                4 => self.migrate_from_v4_to_v5(&conn)?,
                5 => self.migrate_from_v5_to_v6(&conn)?,
                6 => self.migrate_from_v6_to_v7(&conn)?,
                7 => self.migrate_from_v7_to_v8(&conn)?,
                8 => self.migrate_from_v8_to_v9(&conn)?,
                9 => self.migrate_from_v9_to_v10(&conn)?,
                10 => self.migrate_from_v10_to_v11(&conn)?,
                11 => self.migrate_from_v11_to_v12(&conn)?,
                12 => self.migrate_from_v12_to_v13(&conn)?,
                13 => self.migrate_from_v13_to_v14(&conn)?,
                14 => self.migrate_from_v14_to_v15(&conn)?,
                15 => self.migrate_from_v15_to_v16(&conn)?,
                _ => anyhow::bail!(self.build_schema_mismatch_error(current_version)),
            }
            version += 1;
            self.set_user_version(&conn, version)?;
        }

        if version != SCHEMA_VERSION {
            anyhow::bail!(self.build_schema_mismatch_error(version));
        }

        self.create_schema(&conn)?;
        self.ensure_runtime_session_columns(&conn)?;
        self.assert_required_tables_present(&conn)?;
        Ok(())
    }

    fn create_schema(&self, conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
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
                thinking INTEGER DEFAULT 0,
                thinking_at INTEGER,
                seq INTEGER DEFAULT 0,
                ui_state TEXT,
                ui_state_updated_at INTEGER,
                share_token TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);
            CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token) WHERE share_token IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_sessions_ns_updated ON sessions(namespace, updated_at DESC);

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
                thinking INTEGER DEFAULT 0,
                thinking_at INTEGER,
                seq INTEGER DEFAULT 0,
                api_key_id TEXT,
                notes TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);
            CREATE INDEX IF NOT EXISTS idx_machines_ns_updated ON machines(namespace, updated_at DESC);

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
            CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq DESC);
            CREATE INDEX IF NOT EXISTS idx_messages_created_at_desc ON messages(created_at DESC, id DESC);

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
            CREATE INDEX IF NOT EXISTS idx_credentials_ns_updated ON credentials(namespace, updated_at DESC);

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

            CREATE TABLE IF NOT EXISTS invites (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_by TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                redeemed_at INTEGER,
                redeemed_by TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
            CREATE INDEX IF NOT EXISTS idx_invites_namespace ON invites(namespace);

            CREATE TABLE IF NOT EXISTS lobstear_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                bridged_session_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lobstear_devices_namespace ON lobstear_devices(namespace);
            "#,
        )?;
        Ok(())
    }

    fn repair_schema_to_v16(&self, conn: &Connection) -> Result<()> {
        self.migrate_from_v3_to_v4(conn)?;
        self.migrate_from_v4_to_v5(conn)?;
        self.migrate_from_v5_to_v6(conn)?;
        self.migrate_from_v6_to_v7(conn)?;
        self.migrate_from_v7_to_v8(conn)?;
        self.migrate_from_v8_to_v9(conn)?;
        self.migrate_from_v9_to_v10(conn)?;
        self.migrate_from_v10_to_v11(conn)?;
        self.migrate_from_v11_to_v12(conn)?;
        self.migrate_from_v12_to_v13(conn)?;
        self.migrate_from_v13_to_v14(conn)?;
        self.migrate_from_v14_to_v15(conn)?;
        self.migrate_from_v15_to_v16(conn)?;
        Ok(())
    }

    fn migrate_legacy_schema_if_needed(&self, conn: &Connection) -> Result<()> {
        let columns = self.get_column_names(conn, "machines")?;
        if columns.is_empty() {
            return Ok(());
        }

        let has_daemon =
            columns.contains("daemon_state") || columns.contains("daemon_state_version");
        let has_runner =
            columns.contains("runner_state") || columns.contains("runner_state_version");

        if has_daemon && has_runner {
            anyhow::bail!("SQLite schema has both daemon_state and runner_state columns in machines; manual cleanup required.");
        }

        if has_daemon && !has_runner {
            self.migrate_from_v1_to_v2(conn)?;
        }

        Ok(())
    }

    fn migrate_from_v1_to_v2(&self, conn: &Connection) -> Result<()> {
        let columns = self.get_column_names(conn, "machines")?;
        if columns.is_empty() {
            anyhow::bail!("SQLite schema missing machines table for v1 to v2 migration.");
        }

        let has_daemon =
            columns.contains("daemon_state") && columns.contains("daemon_state_version");
        let has_runner =
            columns.contains("runner_state") && columns.contains("runner_state_version");

        if has_runner && !has_daemon {
            return Ok(());
        }

        if !has_daemon {
            anyhow::bail!("SQLite schema missing daemon_state columns for v1 to v2 migration.");
        }

        if conn
            .execute_batch(
                "BEGIN;
             ALTER TABLE machines RENAME COLUMN daemon_state TO runner_state;
             ALTER TABLE machines RENAME COLUMN daemon_state_version TO runner_state_version;
             COMMIT;",
            )
            .is_ok()
        {
            return Ok(());
        }

        let _ = conn.execute_batch("ROLLBACK;");
        conn.execute_batch(
            r#"
            BEGIN;
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
            INSERT INTO machines_new (
                id, namespace, created_at, updated_at, metadata, metadata_version,
                runner_state, runner_state_version, active, active_at, seq
            )
            SELECT id, namespace, created_at, updated_at, metadata, metadata_version,
                   daemon_state, daemon_state_version, active, active_at, seq
            FROM machines;
            DROP TABLE machines;
            ALTER TABLE machines_new RENAME TO machines;
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);
            COMMIT;
            "#,
        )?;
        Ok(())
    }

    fn migrate_from_v2_to_v3(&self) {}

    fn migrate_from_v3_to_v4(&self, conn: &Connection) -> Result<()> {
        if !self.table_exists(conn, "sessions")? {
            return Ok(());
        }
        let columns = self.get_column_names(conn, "sessions")?;
        if !columns.contains("ui_state") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN ui_state TEXT;")?;
        }
        if !columns.contains("ui_state_updated_at") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN ui_state_updated_at INTEGER;")?;
        }
        Ok(())
    }

    fn migrate_from_v4_to_v5(&self, conn: &Connection) -> Result<()> {
        if !self.table_exists(conn, "sessions")? {
            return Ok(());
        }
        let columns = self.get_column_names(conn, "sessions")?;
        if !columns.contains("share_token") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN share_token TEXT;")?;
        }
        conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token) WHERE share_token IS NOT NULL;")?;
        Ok(())
    }

    fn migrate_from_v5_to_v6(&self, conn: &Connection) -> Result<()> {
        if self.table_exists(conn, "messages")? {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);",
            )?;
        }
        Ok(())
    }

    fn migrate_from_v6_to_v7(&self, conn: &Connection) -> Result<()> {
        if !self.table_exists(conn, "messages")? {
            return Ok(());
        }
        conn.execute_batch(
            r#"
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
            "#,
        )?;
        let _ = conn.execute(
            "INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')",
            [],
        );
        Ok(())
    }

    fn migrate_from_v7_to_v8(&self, conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
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
            "#,
        )?;
        Ok(())
    }

    fn migrate_from_v8_to_v9(&self, conn: &Connection) -> Result<()> {
        if !self.table_exists(conn, "messages")? {
            return Ok(());
        }
        let columns = self.get_column_names(conn, "messages")?;
        if !columns.contains("role") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN role TEXT;")?;
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_messages_session_role_seq ON messages(session_id, role, seq);")?;

        let mut stmt =
            conn.prepare("SELECT id, content FROM messages WHERE role IS NULL ORDER BY rowid ASC")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, raw) = row?;
            let parsed = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
            if let Some(role) = infer_role(&parsed) {
                conn.execute(
                    "UPDATE messages SET role = ?1 WHERE id = ?2",
                    params![role, id],
                )?;
            }
        }
        Ok(())
    }

    fn migrate_from_v9_to_v10(&self, conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
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

            CREATE TABLE IF NOT EXISTS lobstear_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                bridged_session_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lobstear_devices_namespace ON lobstear_devices(namespace);
            "#,
        )?;
        Ok(())
    }

    fn migrate_from_v10_to_v11(&self, conn: &Connection) -> Result<()> {
        if self.table_exists(conn, "machines")?
            && !self
                .get_column_names(conn, "machines")?
                .contains("api_key_id")
        {
            conn.execute_batch("ALTER TABLE machines ADD COLUMN api_key_id TEXT;")?;
        }
        Ok(())
    }

    fn migrate_from_v11_to_v12(&self, conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS preferences (
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, key)
            );
            "#,
        )?;
        Ok(())
    }

    fn migrate_from_v12_to_v13(&self, conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS lobstear_devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                bridged_session_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_lobstear_devices_namespace ON lobstear_devices(namespace);
            "#,
        )?;
        Ok(())
    }

    fn migrate_from_v13_to_v14(&self, conn: &Connection) -> Result<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS invites (
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL UNIQUE,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_by TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                redeemed_at INTEGER,
                redeemed_by TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
            CREATE INDEX IF NOT EXISTS idx_invites_namespace ON invites(namespace);
            "#,
        )?;
        Ok(())
    }

    fn migrate_from_v14_to_v15(&self, conn: &Connection) -> Result<()> {
        if self.table_exists(conn, "machines")?
            && !self.get_column_names(conn, "machines")?.contains("notes")
        {
            conn.execute_batch("ALTER TABLE machines ADD COLUMN notes TEXT;")?;
        }
        Ok(())
    }

    fn migrate_from_v15_to_v16(&self, conn: &Connection) -> Result<()> {
        if !self.table_exists(conn, "sessions")? {
            return Ok(());
        }
        if !self
            .get_column_names(conn, "sessions")?
            .contains("parent_session_id")
        {
            conn.execute_batch(
                "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;",
            )?;
        }
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);")?;
        Ok(())
    }

    fn ensure_runtime_session_columns(&self, conn: &Connection) -> Result<()> {
        if !self.table_exists(conn, "sessions")? {
            return Ok(());
        }
        let columns = self.get_column_names(conn, "sessions")?;
        if !columns.contains("thinking") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN thinking INTEGER DEFAULT 0;")?;
        }
        if !columns.contains("thinking_at") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN thinking_at INTEGER;")?;
        }
        Ok(())
    }

    fn get_user_version(&self, conn: &Connection) -> Result<i64> {
        Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    fn set_user_version(&self, conn: &Connection, version: i64) -> Result<()> {
        conn.pragma_update(None, "user_version", version)?;
        Ok(())
    }

    fn has_any_user_tables(&self, conn: &Connection) -> Result<bool> {
        let row: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(row.is_some())
    }

    fn table_exists(&self, conn: &Connection, table: &str) -> Result<bool> {
        let row: Option<String> = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
                params![table],
                |row| row.get(0),
            )
            .optional()?;
        Ok(row.is_some())
    }

    fn get_column_names(
        &self,
        conn: &Connection,
        table: &str,
    ) -> Result<std::collections::HashSet<String>> {
        if !self.table_exists(conn, table)? {
            return Ok(Default::default());
        }
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn assert_required_tables_present(&self, conn: &Connection) -> Result<()> {
        let placeholders = REQUIRED_TABLES
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        let mut stmt = conn.prepare(&format!(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ({})",
            placeholders
        ))?;
        let rows = stmt.query_map(
            rusqlite::params_from_iter(REQUIRED_TABLES.iter().copied()),
            |row| row.get::<_, String>(0),
        )?;
        let existing: std::collections::HashSet<String> = rows.filter_map(Result::ok).collect();
        let missing: Vec<&str> = REQUIRED_TABLES
            .iter()
            .copied()
            .filter(|table| !existing.contains(*table))
            .collect();
        if !missing.is_empty() {
            anyhow::bail!(
                "SQLite schema is missing required tables ({}). Back up and rebuild the database, or run an offline migration to the expected schema version.",
                missing.join(", ")
            );
        }
        Ok(())
    }

    fn build_schema_mismatch_error(&self, current_version: i64) -> String {
        format!(
            "SQLite schema version mismatch. Expected {}, found {}. This build does not run compatibility migrations for unknown future schema versions.",
            SCHEMA_VERSION, current_version
        )
    }

    pub fn seed_legacy_api_key(&self, legacy_token: &str) -> Result<()> {
        use crate::auth::hash_api_key;
        let hash = hash_api_key(legacy_token);
        if self.get_api_key_by_hash(&hash).is_some() {
            return Ok(());
        }
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO api_keys (id, name, key_hash, key_prefix, namespace, permissions, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                "Default (migrated)",
                hash,
                legacy_token.chars().take(12).collect::<String>(),
                "default",
                serde_json::to_string(&vec!["admin"]).unwrap(),
                now,
            ],
        )?;
        Ok(())
    }

    pub fn get_user(&self, platform: &str, platform_user_id: &str) -> Option<StoredUser> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, platform, platform_user_id, namespace, created_at FROM users WHERE platform = ?1 AND platform_user_id = ?2 LIMIT 1",
            params![platform, platform_user_id],
            |row| {
                Ok(StoredUser {
                    id: row.get(0)?,
                    platform: row.get(1)?,
                    platform_user_id: row.get(2)?,
                    namespace: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        ).optional().ok().flatten()
    }

    pub fn add_user(
        &self,
        platform: &str,
        platform_user_id: &str,
        namespace: &str,
    ) -> Result<StoredUser> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR IGNORE INTO users (platform, platform_user_id, namespace, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![platform, platform_user_id, namespace, now],
        )?;
        drop(conn);
        self.get_user(platform, platform_user_id)
            .context("created user missing")
    }

    pub fn get_users_by_platform_and_namespace(
        &self,
        platform: &str,
        namespace: &str,
    ) -> Vec<StoredUser> {
        let conn = self.conn.lock();
        let mut stmt = match conn.prepare(
            "SELECT id, platform, platform_user_id, namespace, created_at FROM users WHERE platform = ?1 AND namespace = ?2 ORDER BY created_at ASC"
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(params![platform, namespace], |row| {
            Ok(StoredUser {
                id: row.get(0)?,
                platform: row.get(1)?,
                platform_user_id: row.get(2)?,
                namespace: row.get(3)?,
                created_at: row.get(4)?,
            })
        }) {
            Ok(rows) => rows,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(Result::ok).collect()
    }

    pub fn get_api_key_by_hash(&self, hash: &str) -> Option<StoredApiKey> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, name, key_hash, key_prefix, namespace, permissions, created_at, revoked_at, last_used_at FROM api_keys WHERE key_hash = ?1",
            params![hash],
            |row| {
                Ok(StoredApiKey {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    key_hash: row.get(2)?,
                    key_prefix: row.get(3)?,
                    namespace: row.get(4)?,
                    permissions: parse_permissions(row.get::<_, String>(5)?),
                    created_at: row.get(6)?,
                    revoked_at: row.get(7)?,
                    last_used_at: row.get(8)?,
                })
            },
        ).optional().ok().flatten()
    }

    pub fn update_api_key_last_used(&self, id: &str) {
        let conn = self.conn.lock();
        let _ = conn.execute(
            "UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        );
    }

    pub fn get_access_token_by_hash(&self, hash: &str) -> Option<StoredAccessToken> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, api_key_id, name, token_hash, token_prefix, namespace, permissions, created_at, expires_at, revoked_at FROM access_tokens WHERE token_hash = ?1",
            params![hash],
            |row| {
                Ok(StoredAccessToken {
                    id: row.get(0)?,
                    api_key_id: row.get(1)?,
                    name: row.get(2)?,
                    token_hash: row.get(3)?,
                    token_prefix: row.get(4)?,
                    namespace: row.get(5)?,
                    permissions: parse_permissions(row.get::<_, String>(6)?),
                    created_at: row.get(7)?,
                    expires_at: row.get(8)?,
                    revoked_at: row.get(9)?,
                })
            },
        ).optional().ok().flatten()
    }

    pub fn get_or_create_session(
        &self,
        tag: &str,
        metadata: &Value,
        agent_state: Option<&Value>,
        namespace: &str,
        parent_session_id: Option<&str>,
    ) -> Result<Session> {
        if let Some(session) = self.find_session_by_tag(tag, namespace) {
            return Ok(session);
        }
        self.create_session(tag, metadata, agent_state, namespace, parent_session_id)
    }

    pub fn create_session(
        &self,
        tag: &str,
        metadata: &Value,
        agent_state: Option<&Value>,
        namespace: &str,
        parent_session_id: Option<&str>,
    ) -> Result<Session> {
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO sessions (
                id, tag, parent_session_id, namespace, machine_id, created_at, updated_at, metadata, metadata_version,
                agent_state, agent_state_version, todos, todos_updated_at, active, active_at, seq, ui_state, ui_state_updated_at, share_token
            ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5, ?6, 1, ?7, 1, NULL, NULL, 0, NULL, 0, NULL, NULL, NULL)"#,
            params![
                id,
                tag,
                parent_session_id,
                namespace,
                now,
                metadata.to_string(),
                agent_state.map(Value::to_string),
            ],
        )?;
        drop(conn);
        self.get_session(&id).context("created session missing")
    }

    pub fn create_credential(
        &self,
        id: &str,
        namespace: &str,
        name: &str,
        agent_type: &str,
        config: &Value,
    ) -> Result<StoredCredential> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO credentials (id, namespace, name, agent_type, config, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, namespace, name, agent_type, config.to_string(), now],
        )?;
        drop(conn);
        self.get_credential_by_namespace(id, namespace)
            .context("created credential missing")
    }

    pub fn update_credential(
        &self,
        id: &str,
        namespace: &str,
        name: Option<&str>,
        config: Option<&Value>,
    ) -> Result<Option<StoredCredential>> {
        let conn = self.conn.lock();
        let existing = conn.query_row(
            "SELECT id, namespace, name, agent_type, config, created_at, updated_at FROM credentials WHERE id = ?1 AND namespace = ?2",
            params![id, namespace],
            row_to_credential,
        ).optional()?;
        let Some(existing) = existing else {
            return Ok(None);
        };
        let next_name = name.unwrap_or(&existing.name);
        let next_config = config.cloned().unwrap_or(existing.config);
        conn.execute(
            "UPDATE credentials SET name = ?3, config = ?4, updated_at = ?5 WHERE id = ?1 AND namespace = ?2",
            params![id, namespace, next_name, next_config.to_string(), now_ms()],
        )?;
        drop(conn);
        Ok(self.get_credential_by_namespace(id, namespace))
    }

    pub fn delete_credential(&self, id: &str, namespace: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let deleted = conn.execute(
            "DELETE FROM credentials WHERE id = ?1 AND namespace = ?2",
            params![id, namespace],
        )?;
        Ok(deleted == 1)
    }

    pub fn get_credential_by_namespace(
        &self,
        id: &str,
        namespace: &str,
    ) -> Option<StoredCredential> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, namespace, name, agent_type, config, created_at, updated_at FROM credentials WHERE id = ?1 AND namespace = ?2",
            params![id, namespace],
            row_to_credential,
        ).optional().ok().flatten()
    }

    pub fn list_credentials_by_namespace(&self, namespace: &str) -> Vec<StoredCredential> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, namespace, name, agent_type, config, created_at, updated_at FROM credentials WHERE namespace = ?1 ORDER BY updated_at DESC")
            .unwrap();
        let rows = stmt
            .query_map(params![namespace], row_to_credential)
            .unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn set_machine_credential(
        &self,
        machine_id: &str,
        agent_type: &str,
        credential_id: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO machine_credentials (machine_id, agent_type, credential_id, applied_at)
               VALUES (?1, ?2, ?3, ?4)
               ON CONFLICT(machine_id, agent_type) DO UPDATE SET credential_id = excluded.credential_id, applied_at = excluded.applied_at"#,
            params![machine_id, agent_type, credential_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn add_push_subscription(
        &self,
        namespace: &str,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO push_subscriptions (namespace, endpoint, p256dh, auth, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(namespace, endpoint) DO UPDATE SET
                   p256dh = excluded.p256dh,
                   auth = excluded.auth,
                   created_at = excluded.created_at"#,
            params![namespace, endpoint, p256dh, auth, now_ms()],
        )?;
        Ok(())
    }

    pub fn remove_push_subscription(&self, namespace: &str, endpoint: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM push_subscriptions WHERE namespace = ?1 AND endpoint = ?2",
            params![namespace, endpoint],
        )?;
        Ok(())
    }

    pub fn list_push_subscriptions_by_namespace(
        &self,
        namespace: &str,
    ) -> Vec<StoredPushSubscription> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, namespace, endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE namespace = ?1 ORDER BY created_at DESC")
            .unwrap();
        let rows = stmt
            .query_map(params![namespace], |row| {
                Ok(StoredPushSubscription {
                    id: row.get(0)?,
                    namespace: row.get(1)?,
                    endpoint: row.get(2)?,
                    p256dh: row.get(3)?,
                    auth: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })
            .unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn get_lobstear_device(&self, id: &str) -> Option<StoredLobstearDevice> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, name, namespace, bridged_session_id, created_at, updated_at FROM lobstear_devices WHERE id = ?1",
            params![id],
            row_to_lobstear_device,
        ).optional().ok().flatten()
    }

    pub fn list_lobstear_devices(&self, namespace: Option<&str>) -> Vec<StoredLobstearDevice> {
        let conn = self.conn.lock();
        let mut stmt = if namespace.is_some() {
            conn.prepare(
                "SELECT id, name, namespace, bridged_session_id, created_at, updated_at FROM lobstear_devices WHERE namespace = ?1 ORDER BY created_at ASC"
            ).unwrap()
        } else {
            conn.prepare(
                "SELECT id, name, namespace, bridged_session_id, created_at, updated_at FROM lobstear_devices ORDER BY created_at ASC"
            ).unwrap()
        };
        let rows = if let Some(namespace) = namespace {
            stmt.query_map(params![namespace], row_to_lobstear_device)
                .unwrap()
        } else {
            stmt.query_map([], row_to_lobstear_device).unwrap()
        };
        rows.filter_map(Result::ok).collect()
    }

    pub fn get_lobstear_devices_by_session(&self, session_id: &str) -> Vec<StoredLobstearDevice> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, name, namespace, bridged_session_id, created_at, updated_at FROM lobstear_devices WHERE bridged_session_id = ?1 ORDER BY created_at ASC"
        ).unwrap();
        let rows = stmt
            .query_map(params![session_id], row_to_lobstear_device)
            .unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn upsert_lobstear_device(
        &self,
        id: &str,
        name: &str,
        namespace: &str,
    ) -> Result<StoredLobstearDevice> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO lobstear_devices (id, name, namespace, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?4)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at"#,
            params![id, name, namespace, now],
        )?;
        drop(conn);
        self.get_lobstear_device(id)
            .context("created lobstear device missing")
    }

    pub fn set_lobstear_bridged_session(&self, id: &str, session_id: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE lobstear_devices SET bridged_session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, session_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn remove_lobstear_device(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM lobstear_devices WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn find_session_by_tag(&self, tag: &str, namespace: &str) -> Option<Session> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM sessions WHERE tag = ?1 AND namespace = ?2 ORDER BY created_at DESC LIMIT 1",
            params![tag, namespace],
            row_to_session,
        ).optional().ok().flatten()
    }

    pub fn get_session(&self, id: &str) -> Option<Session> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM sessions WHERE id = ?1",
            params![id],
            row_to_session,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_session_by_namespace(&self, id: &str, namespace: &str) -> Option<Session> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM sessions WHERE id = ?1 AND namespace = ?2",
            params![id, namespace],
            row_to_session,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_session_by_share_token(&self, share_token: &str) -> Option<Session> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM sessions WHERE share_token = ?1",
            params![share_token],
            row_to_session,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_session_tag(&self, id: &str, namespace: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT tag FROM sessions WHERE id = ?1 AND namespace = ?2",
            params![id, namespace],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn list_sessions(&self, namespace: Option<&str>) -> Vec<Session> {
        let conn = self.conn.lock();
        let mut stmt = if namespace.is_some() {
            conn.prepare("SELECT * FROM sessions WHERE namespace = ?1 ORDER BY updated_at DESC")
                .unwrap()
        } else {
            conn.prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
                .unwrap()
        };
        let rows = if let Some(namespace) = namespace {
            stmt.query_map(params![namespace], row_to_session).unwrap()
        } else {
            stmt.query_map([], row_to_session).unwrap()
        };
        rows.filter_map(Result::ok).collect()
    }

    pub fn list_shared_sessions(&self, namespace: &str) -> Vec<Session> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM sessions WHERE namespace = ?1 AND share_token IS NOT NULL ORDER BY updated_at DESC")
            .unwrap();
        let rows = stmt.query_map(params![namespace], row_to_session).unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn get_pinned_session_ids(&self, namespace: &str) -> std::collections::HashSet<String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id FROM sessions
                 WHERE namespace = ?1
                   AND json_extract(ui_state, '$.pinned') = 1",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![namespace], |row| row.get::<_, String>(0))
            .unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn get_session_tags(
        &self,
        namespace: &str,
    ) -> std::collections::HashMap<String, Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, ui_state FROM sessions
                 WHERE namespace = ?1
                   AND ui_state IS NOT NULL
                   AND json_type(ui_state, '$.tags') = 'array'",
            )
            .unwrap();
        let rows = stmt
            .query_map(params![namespace], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        let mut out = std::collections::HashMap::new();
        for row in rows.filter_map(Result::ok) {
            let (id, ui_state) = row;
            let Some(tags) = serde_json::from_str::<Value>(&ui_state)
                .ok()
                .and_then(|value| value.get("tags").and_then(Value::as_array).cloned())
            else {
                continue;
            };
            let tags: Vec<String> = tags
                .into_iter()
                .filter_map(|tag| tag.as_str().map(ToOwned::to_owned))
                .collect();
            if !tags.is_empty() {
                out.insert(id, tags);
            }
        }
        out
    }

    pub fn append_message(
        &self,
        session_id: &str,
        content: &Value,
        local_id: Option<&str>,
    ) -> Result<DecryptedMessage> {
        let now = now_ms();
        let id = Uuid::new_v4().to_string();
        let seq = {
            let conn = self.conn.lock();
            let current: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO messages (id, session_id, content, created_at, seq, local_id, role) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, session_id, content.to_string(), now, current + 1, local_id, infer_role(content)],
            )?;
            conn.execute(
                "UPDATE sessions SET updated_at = ?2, seq = seq + 1 WHERE id = ?1",
                params![session_id, now],
            )?;
            current + 1
        };
        Ok(DecryptedMessage {
            id,
            seq: Some(seq),
            local_id: local_id.map(ToOwned::to_owned),
            content: content.clone(),
            created_at: now,
        })
    }

    pub fn get_messages_since(
        &self,
        namespace: &str,
        since: i64,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<MessagesSinceResult> {
        let conn = self.conn.lock();
        let (cursor_created_at, cursor_id) = parse_message_cursor(cursor);
        let mut stmt = conn.prepare(
            r#"
            SELECT m.id, m.session_id, m.seq, m.content, m.created_at
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            WHERE s.namespace = ?1
              AND m.created_at >= ?2
              AND (
                ?3 IS NULL
                OR m.created_at < ?3
                OR (m.created_at = ?3 AND m.id < ?4)
              )
            ORDER BY m.created_at DESC, m.id DESC
            LIMIT ?5
            "#,
        )?;
        let rows = stmt.query_map(
            params![namespace, since, cursor_created_at, cursor_id, limit + 1],
            |row| {
                Ok(SyncMessageRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    seq: row.get(2)?,
                    content: serde_json::from_str::<Value>(&row.get::<_, String>(3)?)
                        .unwrap_or(Value::Null),
                    created_at: row.get(4)?,
                })
            },
        )?;
        let mut messages: Vec<_> = rows.filter_map(Result::ok).collect();
        let has_more = messages.len() as i64 > limit;
        if has_more {
            messages.truncate(limit as usize);
        }
        let cursor = messages
            .last()
            .map(|message| format!("{}:{}", message.created_at, message.id));
        messages.reverse();
        Ok(MessagesSinceResult {
            messages,
            cursor,
            has_more,
        })
    }

    pub fn get_messages_page(
        &self,
        session_id: &str,
        limit: i64,
        before_seq: Option<i64>,
        after_seq: Option<i64>,
    ) -> Result<(Vec<DecryptedMessage>, bool)> {
        let conn = self.conn.lock();
        let mut query =
            "SELECT id, seq, local_id, content, created_at FROM messages WHERE session_id = ?1"
                .to_string();
        let mut params_vec: Vec<rusqlite::types::Value> = vec![session_id.to_string().into()];
        if let Some(before) = before_seq {
            query.push_str(&format!(" AND seq < ?{}", params_vec.len() + 1));
            params_vec.push(before.into());
        } else if let Some(after) = after_seq {
            query.push_str(&format!(" AND seq > ?{}", params_vec.len() + 1));
            params_vec.push(after.into());
        }
        query.push_str(&format!(
            " ORDER BY seq DESC LIMIT ?{}",
            params_vec.len() + 1
        ));
        params_vec.push(limit.into());
        let mut stmt = conn.prepare(&query)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params_vec), |row| {
            Ok(DecryptedMessage {
                id: row.get(0)?,
                seq: Some(row.get(1)?),
                local_id: row.get(2)?,
                content: serde_json::from_str::<Value>(&row.get::<_, String>(3)?)
                    .unwrap_or(Value::Null),
                created_at: row.get(4)?,
            })
        })?;
        let mut messages: Vec<_> = rows.filter_map(Result::ok).collect();
        messages.reverse();
        let has_more = messages.len() as i64 >= limit;
        Ok((messages, has_more))
    }

    pub fn search_messages(
        &self,
        session_id: &str,
        search: &str,
        limit: i64,
        offset: i64,
        after_seq: Option<i64>,
        before_seq: Option<i64>,
    ) -> Result<Vec<DecryptedMessage>> {
        let query = normalize_fts_query(search);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT m.id, m.seq, m.local_id, m.content, m.created_at
            FROM messages_fts AS f
            INNER JOIN messages AS m ON m.rowid = f.rowid
            WHERE f.content MATCH ?1
              AND m.session_id = ?2
              AND (?3 IS NULL OR m.seq > ?3)
              AND (?4 IS NULL OR m.seq < ?4)
            ORDER BY m.seq DESC
            LIMIT ?5 OFFSET ?6
            "#,
        )?;
        let rows = stmt.query_map(
            params![
                query,
                session_id,
                after_seq,
                before_seq,
                limit.clamp(1, 200),
                offset.max(0)
            ],
            |row| {
                Ok(DecryptedMessage {
                    id: row.get(0)?,
                    seq: Some(row.get(1)?),
                    local_id: row.get(2)?,
                    content: serde_json::from_str::<Value>(&row.get::<_, String>(3)?)
                        .unwrap_or(Value::Null),
                    created_at: row.get(4)?,
                })
            },
        )?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn get_messages_up_to_seq(
        &self,
        session_id: &str,
        max_seq: i64,
        limit: i64,
    ) -> Result<Vec<DecryptedMessage>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, seq, local_id, content, created_at FROM messages WHERE session_id = ?1 AND seq <= ?2 ORDER BY seq DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, max_seq, limit], |row| {
            Ok(DecryptedMessage {
                id: row.get(0)?,
                seq: Some(row.get(1)?),
                local_id: row.get(2)?,
                content: serde_json::from_str::<Value>(&row.get::<_, String>(3)?)
                    .unwrap_or(Value::Null),
                created_at: row.get(4)?,
            })
        })?;
        let mut messages: Vec<_> = rows.filter_map(Result::ok).collect();
        messages.reverse();
        Ok(messages)
    }

    pub fn get_messages_after(
        &self,
        session_id: &str,
        after_seq: i64,
        limit: i64,
    ) -> Result<Vec<DecryptedMessage>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, seq, local_id, content, created_at FROM messages WHERE session_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![session_id, after_seq, limit], |row| {
            Ok(DecryptedMessage {
                id: row.get(0)?,
                seq: Some(row.get(1)?),
                local_id: row.get(2)?,
                content: serde_json::from_str::<Value>(&row.get::<_, String>(3)?)
                    .unwrap_or(Value::Null),
                created_at: row.get(4)?,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn get_or_create_machine(
        &self,
        id: &str,
        metadata: &Value,
        runner_state: Option<&Value>,
        namespace: &str,
        api_key_id: Option<&str>,
    ) -> Result<Machine> {
        if let Some(_machine) = self.get_machine_by_namespace(id, namespace) {
            // Update metadata and optionally api_key_id for existing machines
            let now = now_ms();
            let conn = self.conn.lock();
            let mut updates = vec![
                "metadata = ?1",
                "metadata_version = metadata_version + 1",
                "updated_at = ?2",
                "seq = seq + 1",
            ];
            if api_key_id.is_some() {
                updates.push("api_key_id = COALESCE(api_key_id, ?4)");
            }
            let sql = format!(
                "UPDATE machines SET {} WHERE id = ?3 AND namespace = ?5",
                updates.join(", ")
            );
            conn.execute(
                &sql,
                params![metadata.to_string(), now, id, api_key_id, namespace],
            )?;
            drop(conn);
            return self.get_machine(id).context("updated machine missing");
        }
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            r#"INSERT INTO machines (
                id, namespace, created_at, updated_at, metadata, metadata_version,
                runner_state, runner_state_version, active, active_at, seq, api_key_id, notes
            ) VALUES (?1, ?2, ?3, ?3, ?4, 1, ?5, 1, 0, NULL, 0, ?6, NULL)"#,
            params![
                id,
                namespace,
                now,
                metadata.to_string(),
                runner_state.map(Value::to_string),
                api_key_id
            ],
        )?;
        drop(conn);
        self.get_machine(id).context("created machine missing")
    }

    pub fn get_machine(&self, id: &str) -> Option<Machine> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM machines WHERE id = ?1",
            params![id],
            row_to_machine,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn get_machine_by_namespace(&self, id: &str, namespace: &str) -> Option<Machine> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM machines WHERE id = ?1 AND namespace = ?2",
            params![id, namespace],
            row_to_machine,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn list_machines(&self, namespace: Option<&str>) -> Vec<Machine> {
        let conn = self.conn.lock();
        let mut stmt = if namespace.is_some() {
            conn.prepare("SELECT * FROM machines WHERE namespace = ?1 ORDER BY updated_at DESC")
                .unwrap()
        } else {
            conn.prepare("SELECT * FROM machines ORDER BY updated_at DESC")
                .unwrap()
        };
        let rows = if let Some(namespace) = namespace {
            stmt.query_map(params![namespace], row_to_machine).unwrap()
        } else {
            stmt.query_map([], row_to_machine).unwrap()
        };
        rows.filter_map(Result::ok).collect()
    }

    pub fn touch_session_alive(
        &self,
        session_id: &str,
        thinking: bool,
        mode: Option<&str>,
        permission_mode: Option<&str>,
        model_mode: Option<&str>,
    ) -> Result<()> {
        let now = now_ms();
        let conn = self.conn.lock();
        let existing: Option<String> = conn
            .query_row(
                "SELECT metadata FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut metadata = existing
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Object(Default::default()));
        let original_metadata = metadata.to_string();
        if let Some(object) = metadata.as_object_mut() {
            if let Some(mode) = mode {
                object.insert("mode".into(), Value::String(mode.to_string()));
            }
            if let Some(permission_mode) = permission_mode {
                object.insert(
                    "permissionMode".into(),
                    Value::String(permission_mode.to_string()),
                );
            }
            if let Some(model_mode) = model_mode {
                object.insert("modelMode".into(), Value::String(model_mode.to_string()));
            }
        }
        let next_metadata = metadata.to_string();
        let machine_id = metadata
            .get("machineId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if next_metadata != original_metadata {
            conn.execute(
                "UPDATE sessions
                 SET active = 1,
                     active_at = ?2,
                     metadata = ?3,
                     metadata_version = metadata_version + 1,
                     seq = seq + 1,
                     machine_id = COALESCE(?4, machine_id),
                     thinking = ?5,
                     thinking_at = ?2
                 WHERE id = ?1",
                params![
                    session_id,
                    now,
                    next_metadata,
                    machine_id,
                    if thinking { 1 } else { 0 }
                ],
            )?;
        } else {
            conn.execute(
                "UPDATE sessions
                 SET active = 1,
                     active_at = ?2,
                     machine_id = COALESCE(?3, machine_id),
                     thinking = ?4,
                     thinking_at = ?2
                 WHERE id = ?1",
                params![session_id, now, machine_id, if thinking { 1 } else { 0 }],
            )?;
        }
        Ok(())
    }

    pub fn end_session(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET active = 0, thinking = 0, thinking_at = ?2 WHERE id = ?1",
            params![session_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn archive_session(&self, session_id: &str, namespace: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE sessions SET active = 0, updated_at = ?3, seq = seq + 1 WHERE id = ?1 AND namespace = ?2",
            params![session_id, namespace, now_ms()],
        )?;
        Ok(updated == 1)
    }

    pub fn delete_session(&self, session_id: &str, namespace: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "DELETE FROM sessions WHERE id = ?1 AND namespace = ?2",
            params![session_id, namespace],
        )?;
        Ok(updated == 1)
    }

    pub fn rename_session(&self, session_id: &str, namespace: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let existing: Option<String> = conn
            .query_row(
                "SELECT metadata FROM sessions WHERE id = ?1 AND namespace = ?2",
                params![session_id, namespace],
                |row| row.get(0),
            )
            .optional()?;
        let Some(existing) = existing else {
            return Ok(false);
        };
        let mut metadata =
            serde_json::from_str::<Value>(&existing).unwrap_or(Value::Object(Default::default()));
        if let Some(object) = metadata.as_object_mut() {
            object.insert("name".into(), Value::String(name.to_string()));
        }
        let updated = conn.execute(
            "UPDATE sessions SET metadata = ?3, metadata_version = metadata_version + 1, updated_at = ?4, seq = seq + 1 WHERE id = ?1 AND namespace = ?2",
            params![session_id, namespace, metadata.to_string(), now_ms()],
        )?;
        Ok(updated == 1)
    }

    pub fn get_session_ui_state(&self, session_id: &str, namespace: &str) -> Option<Value> {
        let conn = self.conn.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT ui_state FROM sessions WHERE id = ?1 AND namespace = ?2",
                params![session_id, namespace],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()?;
        raw.and_then(|value| serde_json::from_str::<Value>(&value).ok())
    }

    pub fn update_session_ui_state(
        &self,
        session_id: &str,
        namespace: &str,
        ui_state: &Value,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE sessions SET ui_state = ?3, ui_state_updated_at = ?4 WHERE id = ?1 AND namespace = ?2",
            params![session_id, namespace, ui_state.to_string(), now_ms()],
        )?;
        Ok(updated == 1)
    }

    pub fn set_share_token(
        &self,
        session_id: &str,
        namespace: &str,
        share_token: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE sessions SET share_token = ?3 WHERE id = ?1 AND namespace = ?2",
            params![session_id, namespace, share_token],
        )?;
        Ok(updated == 1)
    }

    pub fn create_forked_session(
        &self,
        source_session_id: &str,
        namespace: &str,
        message_seq: i64,
        tag: &str,
        metadata: &Value,
    ) -> Result<Session> {
        let created =
            self.create_session(tag, metadata, None, namespace, Some(source_session_id))?;
        self.copy_messages_to_session(source_session_id, &created.id, message_seq)?;
        self.copy_prompt_ui_state(source_session_id, &created.id, namespace)?;
        Ok(created)
    }

    pub fn merge_sessions(
        &self,
        old_session_id: &str,
        new_session_id: &str,
        namespace: &str,
    ) -> Result<()> {
        if old_session_id == new_session_id {
            return Ok(());
        }
        let conn = self.conn.lock();

        let old_max_seq: i64 = conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE session_id = ?1",
            params![old_session_id],
            |row| row.get(0),
        )?;
        let new_max_seq: i64 = conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE session_id = ?1",
            params![new_session_id],
            |row| row.get(0),
        )?;

        // Shift new session's message seqs to make room for old session's messages
        if new_max_seq > 0 && old_max_seq > 0 {
            conn.execute(
                "UPDATE messages SET seq = seq + ?1 WHERE session_id = ?2",
                params![old_max_seq, new_session_id],
            )?;
        }

        // Clear local_id collisions
        let collisions: Vec<String> = {
            let mut stmt = conn.prepare(
                r#"SELECT local_id FROM messages WHERE session_id = ?1 AND local_id IS NOT NULL
                   INTERSECT
                   SELECT local_id FROM messages WHERE session_id = ?2 AND local_id IS NOT NULL"#,
            )?;
            let rows = stmt.query_map(params![new_session_id, old_session_id], |row| row.get(0))?
                .filter_map(Result::ok)
                .collect();
            rows
        };
        if !collisions.is_empty() {
            for local_id in &collisions {
                conn.execute(
                    "UPDATE messages SET local_id = NULL WHERE session_id = ?1 AND local_id = ?2",
                    params![old_session_id, local_id],
                )?;
            }
        }

        // Move all messages from old to new
        conn.execute(
            "UPDATE messages SET session_id = ?1 WHERE session_id = ?2",
            params![new_session_id, old_session_id],
        )?;

        // Merge metadata (name, summary, worktree) from old into new
        let old_metadata: Option<String> = conn
            .query_row(
                "SELECT metadata FROM sessions WHERE id = ?1 AND namespace = ?2",
                params![old_session_id, namespace],
                |row| row.get(0),
            )
            .optional()?;
        let new_metadata: Option<String> = conn
            .query_row(
                "SELECT metadata FROM sessions WHERE id = ?1 AND namespace = ?2",
                params![new_session_id, namespace],
                |row| row.get(0),
            )
            .optional()?;
        if let (Some(old_meta_str), Some(new_meta_str)) = (old_metadata, new_metadata) {
            if let (Ok(Value::Object(old_obj)), Ok(Value::Object(mut new_obj))) = (
                serde_json::from_str::<Value>(&old_meta_str),
                serde_json::from_str::<Value>(&new_meta_str),
            ) {
                let mut changed = false;
                if old_obj.get("name").and_then(Value::as_str).is_some()
                    && new_obj.get("name").and_then(Value::as_str).is_none()
                {
                    new_obj.insert("name".to_string(), old_obj["name"].clone());
                    changed = true;
                }
                if old_obj.contains_key("worktree") && !new_obj.contains_key("worktree") {
                    new_obj.insert("worktree".to_string(), old_obj["worktree"].clone());
                    changed = true;
                }
                if changed {
                    conn.execute(
                        "UPDATE sessions SET metadata = ?1 WHERE id = ?2 AND namespace = ?3",
                        params![
                            serde_json::to_string(&Value::Object(new_obj))?,
                            new_session_id,
                            namespace
                        ],
                    )?;
                }
            }
        }

        // Copy parentSessionId from old to new if new doesn't have one
        let old_parent: Option<String> = conn
            .query_row(
                "SELECT parent_session_id FROM sessions WHERE id = ?1",
                params![old_session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let new_parent: Option<String> = conn
            .query_row(
                "SELECT parent_session_id FROM sessions WHERE id = ?1",
                params![new_session_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if old_parent.is_some() && new_parent.is_none() {
            conn.execute(
                "UPDATE sessions SET parent_session_id = ?1 WHERE id = ?2",
                params![old_parent, new_session_id],
            )?;
        }

        // Delete old session
        conn.execute(
            "DELETE FROM sessions WHERE id = ?1 AND namespace = ?2",
            params![old_session_id, namespace],
        )?;

        Ok(())
    }

    pub fn copy_messages_to_session(
        &self,
        source_session_id: &str,
        target_session_id: &str,
        message_seq: i64,
    ) -> Result<()> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT content, created_at, seq, local_id, role FROM messages WHERE session_id = ?1 AND seq <= ?2 ORDER BY seq ASC"
        )?;
        let rows = stmt.query_map(params![source_session_id, message_seq], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        for row in rows {
            let (content, created_at, seq, local_id, role) = row?;
            conn.execute(
                "INSERT INTO messages (id, session_id, content, created_at, seq, local_id, role) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![Uuid::new_v4().to_string(), target_session_id, content, created_at, seq, local_id, role],
            )?;
        }
        conn.execute(
            "UPDATE sessions SET seq = ?2, updated_at = ?3 WHERE id = ?1",
            params![target_session_id, message_seq, now_ms()],
        )?;
        Ok(())
    }

    pub fn copy_prompt_ui_state(
        &self,
        source_session_id: &str,
        target_session_id: &str,
        namespace: &str,
    ) -> Result<()> {
        let Some(source_state) = self.get_session_ui_state(source_session_id, namespace) else {
            return Ok(());
        };
        let mut prompt_state = serde_json::Map::new();
        if let Some(system_prompt) = source_state
            .get("systemPrompt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            prompt_state.insert(
                "systemPrompt".into(),
                Value::String(system_prompt.to_string()),
            );
        }
        if let Some(use_global_prompt) =
            source_state.get("useGlobalPrompt").and_then(Value::as_bool)
        {
            prompt_state.insert("useGlobalPrompt".into(), Value::Bool(use_global_prompt));
        }
        if prompt_state.is_empty() {
            return Ok(());
        }
        let _ = self.update_session_ui_state(
            target_session_id,
            namespace,
            &Value::Object(prompt_state),
        )?;
        Ok(())
    }

    pub fn touch_machine_alive(&self, machine_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE machines SET active = 1, active_at = ?2 WHERE id = ?1",
            params![machine_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn deactivate_machine(&self, machine_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE machines SET active = 0 WHERE id = ?1",
            params![machine_id],
        )?;
        Ok(())
    }

    pub fn expire_inactive_machines(&self, timeout_ms: i64) -> Result<Vec<String>> {
        let cutoff = now_ms() - timeout_ms;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id FROM machines WHERE active = 1 AND active_at < ?1",
        )?;
        let ids: Vec<String> = stmt
            .query_map(params![cutoff], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        if !ids.is_empty() {
            conn.execute(
                "UPDATE machines SET active = 0 WHERE active = 1 AND active_at < ?1",
                params![cutoff],
            )?;
        }
        Ok(ids)
    }

    pub fn update_machine_notes(
        &self,
        machine_id: &str,
        namespace: &str,
        notes: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE machines SET notes = ?3, updated_at = ?4, seq = seq + 1 WHERE id = ?1 AND namespace = ?2",
            params![machine_id, namespace, notes, now_ms()],
        )?;
        Ok(updated == 1)
    }

    pub fn unbind_machine(&self, machine_id: &str, namespace: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE machines SET api_key_id = NULL WHERE id = ?1 AND namespace = ?2",
            params![machine_id, namespace],
        )?;
        Ok(updated == 1)
    }

    pub fn delete_machine(&self, machine_id: &str, namespace: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "DELETE FROM machines WHERE id = ?1 AND namespace = ?2",
            params![machine_id, namespace],
        )?;
        if updated == 1 {
            conn.execute(
                "DELETE FROM machine_credentials WHERE machine_id = ?1",
                params![machine_id],
            )?;
        }
        Ok(updated == 1)
    }

    pub fn get_api_key_name(&self, id: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT name FROM api_keys WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn create_api_key(
        &self,
        id: &str,
        name: &str,
        key_hash: &str,
        key_prefix: &str,
        namespace: &str,
        permissions: &[String],
    ) -> Result<StoredApiKey> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO api_keys (id, name, key_hash, key_prefix, namespace, permissions, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, name, key_hash, key_prefix, namespace, serde_json::to_string(permissions).unwrap(), now],
        )?;
        drop(conn);
        self.get_api_key_by_id(id)
            .context("created api key missing")
    }

    pub fn get_api_key_by_id(&self, id: &str) -> Option<StoredApiKey> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, name, key_hash, key_prefix, namespace, permissions, created_at, revoked_at, last_used_at FROM api_keys WHERE id = ?1",
            params![id],
            |row| {
                Ok(StoredApiKey {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    key_hash: row.get(2)?,
                    key_prefix: row.get(3)?,
                    namespace: row.get(4)?,
                    permissions: parse_permissions(row.get::<_, String>(5)?),
                    created_at: row.get(6)?,
                    revoked_at: row.get(7)?,
                    last_used_at: row.get(8)?,
                })
            },
        ).optional().ok().flatten()
    }

    pub fn list_api_keys(&self, namespace: Option<&str>) -> Vec<StoredApiKey> {
        let conn = self.conn.lock();
        if let Some(namespace) = namespace {
            let mut stmt = conn.prepare("SELECT id, name, key_hash, key_prefix, namespace, permissions, created_at, revoked_at, last_used_at FROM api_keys WHERE namespace = ?1 ORDER BY created_at DESC").unwrap();
            let rows = stmt
                .query_map(params![namespace], |row| {
                    Ok(StoredApiKey {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        key_hash: row.get(2)?,
                        key_prefix: row.get(3)?,
                        namespace: row.get(4)?,
                        permissions: parse_permissions(row.get::<_, String>(5)?),
                        created_at: row.get(6)?,
                        revoked_at: row.get(7)?,
                        last_used_at: row.get(8)?,
                    })
                })
                .unwrap();
            rows.filter_map(Result::ok).collect()
        } else {
            let mut stmt = conn.prepare("SELECT id, name, key_hash, key_prefix, namespace, permissions, created_at, revoked_at, last_used_at FROM api_keys ORDER BY created_at DESC").unwrap();
            let rows = stmt
                .query_map([], |row| {
                    Ok(StoredApiKey {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        key_hash: row.get(2)?,
                        key_prefix: row.get(3)?,
                        namespace: row.get(4)?,
                        permissions: parse_permissions(row.get::<_, String>(5)?),
                        created_at: row.get(6)?,
                        revoked_at: row.get(7)?,
                        last_used_at: row.get(8)?,
                    })
                })
                .unwrap();
            rows.filter_map(Result::ok).collect()
        }
    }

    pub fn update_api_key(
        &self,
        id: &str,
        name: Option<&str>,
        permissions: Option<&[String]>,
    ) -> Result<Option<StoredApiKey>> {
        let Some(existing) = self.get_api_key_by_id(id) else {
            return Ok(None);
        };
        if existing.revoked_at.is_some() {
            return Ok(None);
        }
        let next_name = name.unwrap_or(&existing.name);
        let next_permissions = permissions
            .map(ToOwned::to_owned)
            .unwrap_or(existing.permissions);
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE api_keys SET name = ?2, permissions = ?3 WHERE id = ?1 AND revoked_at IS NULL",
            params![
                id,
                next_name,
                serde_json::to_string(&next_permissions).unwrap()
            ],
        )?;
        drop(conn);
        Ok(self.get_api_key_by_id(id))
    }

    pub fn revoke_api_key(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE api_keys SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![id, now_ms()],
        )?;
        Ok(updated == 1)
    }

    pub fn restore_api_key(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE api_keys SET revoked_at = NULL WHERE id = ?1 AND revoked_at IS NOT NULL",
            params![id],
        )?;
        Ok(updated == 1)
    }

    pub fn create_access_token(
        &self,
        id: &str,
        api_key_id: &str,
        name: &str,
        token_hash: &str,
        token_prefix: &str,
        namespace: &str,
        permissions: &[String],
        expires_at: i64,
    ) -> Result<StoredAccessToken> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO access_tokens (id, api_key_id, name, token_hash, token_prefix, namespace, permissions, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, api_key_id, name, token_hash, token_prefix, namespace, serde_json::to_string(permissions).unwrap(), now, expires_at],
        )?;
        drop(conn);
        self.get_access_token(id)
            .context("created access token missing")
    }

    pub fn get_access_token(&self, id: &str) -> Option<StoredAccessToken> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, api_key_id, name, token_hash, token_prefix, namespace, permissions, created_at, expires_at, revoked_at FROM access_tokens WHERE id = ?1",
            params![id],
            |row| {
                Ok(StoredAccessToken {
                    id: row.get(0)?,
                    api_key_id: row.get(1)?,
                    name: row.get(2)?,
                    token_hash: row.get(3)?,
                    token_prefix: row.get(4)?,
                    namespace: row.get(5)?,
                    permissions: parse_permissions(row.get::<_, String>(6)?),
                    created_at: row.get(7)?,
                    expires_at: row.get(8)?,
                    revoked_at: row.get(9)?,
                })
            },
        ).optional().ok().flatten()
    }

    pub fn list_access_tokens_by_api_key(&self, api_key_id: &str) -> Vec<StoredAccessToken> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, api_key_id, name, token_hash, token_prefix, namespace, permissions, created_at, expires_at, revoked_at FROM access_tokens WHERE api_key_id = ?1 ORDER BY created_at DESC")
            .unwrap();
        let rows = stmt
            .query_map(params![api_key_id], |row| {
                Ok(StoredAccessToken {
                    id: row.get(0)?,
                    api_key_id: row.get(1)?,
                    name: row.get(2)?,
                    token_hash: row.get(3)?,
                    token_prefix: row.get(4)?,
                    namespace: row.get(5)?,
                    permissions: parse_permissions(row.get::<_, String>(6)?),
                    created_at: row.get(7)?,
                    expires_at: row.get(8)?,
                    revoked_at: row.get(9)?,
                })
            })
            .unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn update_access_token(
        &self,
        id: &str,
        name: Option<&str>,
        expires_at: Option<i64>,
    ) -> Result<Option<StoredAccessToken>> {
        let Some(existing) = self.get_access_token(id) else {
            return Ok(None);
        };
        let next_name = name.unwrap_or(&existing.name);
        let next_expires_at = expires_at.unwrap_or(existing.expires_at);
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE access_tokens SET name = ?2, expires_at = ?3 WHERE id = ?1",
            params![id, next_name, next_expires_at],
        )?;
        drop(conn);
        Ok(self.get_access_token(id))
    }

    pub fn revoke_access_token(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE access_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![id, now_ms()],
        )?;
        Ok(updated == 1)
    }

    pub fn restore_access_token(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE access_tokens SET revoked_at = NULL WHERE id = ?1 AND revoked_at IS NOT NULL",
            params![id],
        )?;
        Ok(updated == 1)
    }

    pub fn extend_access_token(&self, id: &str, expires_at: i64) -> Result<bool> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE access_tokens SET expires_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
            params![id, expires_at],
        )?;
        Ok(updated == 1)
    }

    pub fn revoke_access_tokens_by_api_key(&self, api_key_id: &str) -> Result<usize> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE access_tokens SET revoked_at = ?2 WHERE api_key_id = ?1 AND revoked_at IS NULL",
            params![api_key_id, now_ms()],
        )?;
        Ok(updated)
    }

    pub fn get_preference(&self, namespace: &str, key: &str) -> Option<String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT value FROM preferences WHERE namespace = ?1 AND key = ?2",
            params![namespace, key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn set_preference(&self, namespace: &str, key: &str, value: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        match value {
            Some(value) => {
                conn.execute(
                    r#"INSERT INTO preferences (namespace, key, value, updated_at)
                       VALUES (?1, ?2, ?3, ?4)
                       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"#,
                    params![namespace, key, value, now_ms()],
                )?;
            }
            None => {
                conn.execute(
                    "DELETE FROM preferences WHERE namespace = ?1 AND key = ?2",
                    params![namespace, key],
                )?;
            }
        }
        Ok(())
    }

    pub fn create_invite(
        &self,
        id: &str,
        code: &str,
        namespace: &str,
        created_by: &str,
        expires_at: i64,
    ) -> Result<StoredInvite> {
        let now = now_ms();
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO invites (id, code, namespace, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, code, namespace, created_by, now, expires_at],
        )?;
        Ok(StoredInvite {
            id: id.to_string(),
            code: code.to_string(),
            namespace: namespace.to_string(),
            created_by: created_by.to_string(),
            created_at: now,
            expires_at,
            redeemed_at: None,
            redeemed_by: None,
        })
    }

    pub fn list_invites_by_namespace(&self, namespace: &str) -> Vec<StoredInvite> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, code, namespace, created_by, created_at, expires_at, redeemed_at, redeemed_by FROM invites WHERE namespace = ?1 ORDER BY created_at DESC")
            .unwrap();
        let rows = stmt
            .query_map(params![namespace], |row| {
                Ok(StoredInvite {
                    id: row.get(0)?,
                    code: row.get(1)?,
                    namespace: row.get(2)?,
                    created_by: row.get(3)?,
                    created_at: row.get(4)?,
                    expires_at: row.get(5)?,
                    redeemed_at: row.get(6)?,
                    redeemed_by: row.get(7)?,
                })
            })
            .unwrap();
        rows.filter_map(Result::ok).collect()
    }

    pub fn update_session_metadata(
        &self,
        session_id: &str,
        namespace: &str,
        expected_version: i64,
        metadata: &Value,
    ) -> Result<VersionedUpdate<Value>> {
        self.versioned_update(
            "sessions",
            session_id,
            namespace,
            "metadata",
            "metadata_version",
            expected_version,
            metadata,
        )
    }

    pub fn update_session_agent_state(
        &self,
        session_id: &str,
        namespace: &str,
        expected_version: i64,
        agent_state: &Value,
    ) -> Result<VersionedUpdate<Value>> {
        self.versioned_update(
            "sessions",
            session_id,
            namespace,
            "agent_state",
            "agent_state_version",
            expected_version,
            agent_state,
        )
    }

    pub fn update_machine_metadata(
        &self,
        machine_id: &str,
        namespace: &str,
        expected_version: i64,
        metadata: &Value,
    ) -> Result<VersionedUpdate<Value>> {
        self.versioned_update(
            "machines",
            machine_id,
            namespace,
            "metadata",
            "metadata_version",
            expected_version,
            metadata,
        )
    }

    pub fn update_machine_state(
        &self,
        machine_id: &str,
        namespace: &str,
        expected_version: i64,
        state: &Value,
    ) -> Result<VersionedUpdate<Value>> {
        self.versioned_update(
            "machines",
            machine_id,
            namespace,
            "runner_state",
            "runner_state_version",
            expected_version,
            state,
        )
    }

    fn versioned_update(
        &self,
        table: &str,
        id: &str,
        namespace: &str,
        field: &str,
        version_field: &str,
        expected_version: i64,
        value: &Value,
    ) -> Result<VersionedUpdate<Value>> {
        let now = now_ms();
        let conn = self.conn.lock();
        let sql = format!(
            "UPDATE {table} SET {field} = ?1, {version_field} = {version_field} + 1, updated_at = ?2, seq = seq + 1 WHERE id = ?3 AND namespace = ?4 AND {version_field} = ?5"
        );
        let updated = conn.execute(
            &sql,
            params![value.to_string(), now, id, namespace, expected_version],
        )?;
        if updated == 1 {
            return Ok(VersionedUpdate::Success {
                version: expected_version + 1,
                value: value.clone(),
            });
        }
        let sql = format!(
            "SELECT {field}, {version_field} FROM {table} WHERE id = ?1 AND namespace = ?2"
        );
        let current: Option<(Option<String>, i64)> = conn
            .query_row(&sql, params![id, namespace], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        match current {
            Some((raw, version)) => Ok(VersionedUpdate::VersionMismatch {
                version,
                value: raw
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .unwrap_or(Value::Null),
            }),
            None => Ok(VersionedUpdate::Error),
        }
    }
}

#[derive(Debug, Clone)]
pub enum VersionedUpdate<T> {
    Success { version: i64, value: T },
    VersionMismatch { version: i64, value: T },
    Error,
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    let metadata: Option<String> = row.get("metadata")?;
    let agent_state: Option<String> = row.get("agent_state")?;
    let metadata_value = metadata
        .as_ref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let agent_state_value = agent_state
        .as_ref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    let active: i64 = row.get("active")?;
    let active_at: Option<i64> = row.get("active_at")?;
    let thinking: Option<i64> = row.get("thinking")?;
    let thinking_at: Option<i64> = row.get("thinking_at")?;
    Ok(Session {
        id: row.get("id")?,
        parent_session_id: row.get("parent_session_id")?,
        namespace: row.get("namespace")?,
        seq: row.get("seq")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        active: active == 1,
        active_at: active_at.unwrap_or(0),
        metadata: metadata_value.clone(),
        metadata_version: row.get("metadata_version")?,
        agent_state: agent_state_value.clone(),
        agent_state_version: row.get("agent_state_version")?,
        thinking: thinking.map(|value| value != 0).unwrap_or_else(|| {
            agent_state_value
                .as_ref()
                .and_then(|value| {
                    value
                        .get("requests")
                        .and_then(|value| value.as_object().map(|value| !value.is_empty()))
                })
                .unwrap_or(false)
        }),
        thinking_at: thinking_at.unwrap_or_else(|| active_at.unwrap_or(0)),
        todos: None,
        permission_mode: metadata_value
            .as_ref()
            .and_then(|value| value.get("permissionMode"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model_mode: metadata_value
            .as_ref()
            .and_then(|value| value.get("modelMode"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        share_token: row.get("share_token")?,
    })
}

fn row_to_machine(row: &rusqlite::Row<'_>) -> rusqlite::Result<Machine> {
    let metadata: Option<String> = row.get("metadata")?;
    let runner_state: Option<String> = row.get("runner_state")?;
    let active: i64 = row.get("active")?;
    Ok(Machine {
        id: row.get("id")?,
        namespace: row.get("namespace")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        metadata: metadata.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
        metadata_version: row.get("metadata_version")?,
        runner_state: runner_state.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
        runner_state_version: row.get("runner_state_version")?,
        active: active == 1,
        active_at: row.get::<_, Option<i64>>("active_at")?.unwrap_or(0),
        seq: row.get("seq")?,
        api_key_id: row.get("api_key_id")?,
        notes: row.get("notes")?,
    })
}

fn row_to_credential(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCredential> {
    Ok(StoredCredential {
        id: row.get(0)?,
        namespace: row.get(1)?,
        name: row.get(2)?,
        agent_type: row.get(3)?,
        config: serde_json::from_str::<Value>(&row.get::<_, String>(4)?).unwrap_or(Value::Null),
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn row_to_lobstear_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredLobstearDevice> {
    Ok(StoredLobstearDevice {
        id: row.get(0)?,
        name: row.get(1)?,
        namespace: row.get(2)?,
        bridged_session_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn parse_message_cursor(cursor: Option<&str>) -> (Option<i64>, Option<String>) {
    let Some(cursor) = cursor else {
        return (None, None);
    };
    let Some((created_at, id)) = cursor.split_once(':') else {
        return (None, None);
    };
    let Ok(created_at) = created_at.parse::<i64>() else {
        return (None, None);
    };
    (Some(created_at), Some(id.to_string()))
}

fn parse_permissions(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn infer_role(content: &Value) -> Option<String> {
    content
        .get("role")
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .or_else(|| {
            content
                .get("message")
                .and_then(|value| value.get("role"))
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned)
        })
}

fn normalize_fts_query(raw: &str) -> String {
    let tokens: Vec<String> = raw
        .trim()
        .split_whitespace()
        .map(|token| token.replace('"', " ").trim().to_string())
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    tokens
        .iter()
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
