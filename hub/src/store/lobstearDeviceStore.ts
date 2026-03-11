import type { Database } from 'bun:sqlite'

export interface LobstearDevice {
    id: string
    name: string
    namespace: string
    bridgedSessionId: string | null
    createdAt: number
    updatedAt: number
}

interface DeviceRow {
    id: string
    name: string
    namespace: string
    bridged_session_id: string | null
    created_at: number
    updated_at: number
}

function toDevice(row: DeviceRow): LobstearDevice {
    return {
        id: row.id,
        name: row.name,
        namespace: row.namespace,
        bridgedSessionId: row.bridged_session_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export class LobstearDeviceStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getDevice(id: string): LobstearDevice | null {
        const row = this.db.prepare(
            'SELECT * FROM lobstear_devices WHERE id = ?'
        ).get(id) as DeviceRow | undefined
        return row ? toDevice(row) : null
    }

    listDevices(namespace?: string): LobstearDevice[] {
        if (namespace) {
            const rows = this.db.prepare(
                'SELECT * FROM lobstear_devices WHERE namespace = ? ORDER BY created_at'
            ).all(namespace) as DeviceRow[]
            return rows.map(toDevice)
        }
        const rows = this.db.prepare(
            'SELECT * FROM lobstear_devices ORDER BY created_at'
        ).all() as DeviceRow[]
        return rows.map(toDevice)
    }

    getDevicesBySession(sessionId: string): LobstearDevice[] {
        const rows = this.db.prepare(
            'SELECT * FROM lobstear_devices WHERE bridged_session_id = ?'
        ).all(sessionId) as DeviceRow[]
        return rows.map(toDevice)
    }

    upsertDevice(id: string, name: string, namespace: string): LobstearDevice {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO lobstear_devices (id, name, namespace, created_at, updated_at)
            VALUES (@id, @name, @namespace, @now, @now)
            ON CONFLICT(id) DO UPDATE
            SET name = @name, updated_at = @now
        `).run({ id, name, namespace, now })
        return this.getDevice(id)!
    }

    setBridgedSession(id: string, sessionId: string | null): void {
        this.db.prepare(
            'UPDATE lobstear_devices SET bridged_session_id = ?, updated_at = ? WHERE id = ?'
        ).run(sessionId, Date.now(), id)
    }

    removeDevice(id: string): void {
        this.db.prepare('DELETE FROM lobstear_devices WHERE id = ?').run(id)
    }
}
