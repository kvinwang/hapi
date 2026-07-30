import { Database } from 'bun:sqlite'

type MigrationState = {
    status: 'backfilling' | 'ready'
    cursor_rowid: number
    target_rowid: number
}

type MessageRow = {
    rowid: number
    session_id: string
    content: string
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Expected a positive integer, received: ${raw}`)
    }
    return value
}

const dbPath = process.argv[2]
if (!dbPath) {
    throw new Error('Usage: bun run hub/scripts/backfill-message-fts-v2.ts <database> [batch-size] [pause-ms]')
}

const batchSize = readPositiveInteger(process.argv[3], 100)
const pauseMs = readPositiveInteger(process.argv[4], 25)
const db = new Database(dbPath, { readwrite: true, strict: true })
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA busy_timeout = 5000')

const getState = db.prepare(
    'SELECT status, cursor_rowid, target_rowid FROM message_fts_migration WHERE id = 1'
)
const getBatch = db.prepare(`
    SELECT rowid, session_id, content
    FROM messages
    WHERE rowid > ? AND rowid <= ?
    ORDER BY rowid ASC
    LIMIT ?
`)
const insertMessage = db.prepare(`
    INSERT INTO messages_fts_v2(rowid, session_id, content)
    VALUES (?, ?, ?)
`)
const updateCursor = db.prepare(`
    UPDATE message_fts_migration
    SET cursor_rowid = ?, updated_at = ?
    WHERE id = 1
`)

let indexed = 0
let lastProgressLog = Date.now()

while (true) {
    db.exec('BEGIN IMMEDIATE')
    try {
        const state = getState.get() as MigrationState | undefined
        if (!state) throw new Error('FTS migration state is missing')
        if (state.status === 'ready') {
            db.exec('COMMIT')
            console.log('FTS v2 is already ready')
            break
        }

        const rows = getBatch.all(state.cursor_rowid, state.target_rowid, batchSize) as MessageRow[]
        for (const row of rows) {
            insertMessage.run(row.rowid, row.session_id, row.content)
        }

        const cursor = rows.at(-1)?.rowid ?? state.target_rowid
        updateCursor.run(cursor, Date.now())
        db.exec('COMMIT')
        indexed += rows.length

        if (cursor >= state.target_rowid) {
            db.exec('BEGIN IMMEDIATE')
            try {
                db.exec(`
                    DROP TRIGGER IF EXISTS messages_fts_v2_ai;
                    DROP TRIGGER IF EXISTS messages_fts_v2_ad;
                    DROP TRIGGER IF EXISTS messages_fts_v2_au;
                    CREATE TRIGGER messages_fts_v2_ai AFTER INSERT ON messages BEGIN
                        INSERT INTO messages_fts_v2(rowid, session_id, content)
                        VALUES (new.rowid, new.session_id, new.content);
                    END;
                    CREATE TRIGGER messages_fts_v2_ad AFTER DELETE ON messages BEGIN
                        INSERT INTO messages_fts_v2(messages_fts_v2, rowid, session_id, content)
                        VALUES ('delete', old.rowid, old.session_id, old.content);
                    END;
                    CREATE TRIGGER messages_fts_v2_au AFTER UPDATE ON messages BEGIN
                        INSERT INTO messages_fts_v2(messages_fts_v2, rowid, session_id, content)
                        VALUES ('delete', old.rowid, old.session_id, old.content);
                        INSERT INTO messages_fts_v2(rowid, session_id, content)
                        VALUES (new.rowid, new.session_id, new.content);
                    END;
                    UPDATE message_fts_migration
                    SET status = 'ready', cursor_rowid = target_rowid,
                        updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
                    WHERE id = 1;
                `)
                db.exec('COMMIT')
            } catch (error) {
                db.exec('ROLLBACK')
                throw error
            }
            console.log(`FTS v2 backfill complete; indexed ${indexed} messages in this run`)
            break
        }

        if (Date.now() - lastProgressLog >= 5_000) {
            const percent = state.target_rowid === 0 ? 100 : (cursor / state.target_rowid) * 100
            console.log(`FTS v2 backfill: rowid ${cursor}/${state.target_rowid} (${percent.toFixed(2)}%)`)
            lastProgressLog = Date.now()
        }
    } catch (error) {
        try {
            db.exec('ROLLBACK')
        } catch {
        }
        throw error
    }

    await Bun.sleep(pauseMs)
}

db.close()
