use rusqlite::Connection;
use std::sync::Mutex;
use tracing::info;

/// Persistent sync state stored in a local SQLite database.
/// Wrapped in Mutex to be Send + Sync for use in async contexts.
pub struct SyncState {
    conn: Mutex<Connection>,
}

impl SyncState {
    pub fn open(path: &str) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
        )?;
        info!("Sync state DB opened: {path}");
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT value FROM sync_state WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("lock: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
            [key, value],
        )?;
        Ok(())
    }

    /// Get the cursor for message sync.
    pub fn get_cursor(&self) -> Option<String> {
        self.get("messages_cursor")
    }

    /// Set the cursor for message sync.
    pub fn set_cursor(&self, cursor: &str) -> anyhow::Result<()> {
        self.set("messages_cursor", cursor)
    }

    /// Get the last sync timestamp (created_at of last processed message).
    pub fn get_last_sync_ts(&self) -> i64 {
        self.get("last_sync_ts")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }

    /// Set the last sync timestamp.
    pub fn set_last_sync_ts(&self, ts: i64) -> anyhow::Result<()> {
        self.set("last_sync_ts", &ts.to_string())
    }
}
