import type { Database } from 'bun:sqlite'

import type { StoredMachine, VersionedUpdateResult } from './types'
import { safeJsonParse } from './json'
import { updateVersionedField } from './versionedUpdates'

type DbMachineRow = {
    id: string
    namespace: string
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    runner_state: string | null
    runner_state_version: number
    active: number
    active_at: number | null
    seq: number
    api_key_id: string | null
}

function toStoredMachine(row: DbMachineRow): StoredMachine {
    return {
        id: row.id,
        namespace: row.namespace,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        runnerState: safeJsonParse(row.runner_state),
        runnerStateVersion: row.runner_state_version,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq,
        apiKeyId: row.api_key_id
    }
}

export function getOrCreateMachine(
    db: Database,
    id: string,
    metadata: unknown,
    runnerState: unknown,
    namespace: string,
    apiKeyId: string | null = null
): StoredMachine {
    const existing = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
    if (existing) {
        const stored = toStoredMachine(existing)
        if (stored.namespace !== namespace) {
            throw new Error('Machine namespace mismatch')
        }
        const updates: string[] = []
        const params: Record<string, unknown> = { id }
        if (apiKeyId && !stored.apiKeyId) {
            updates.push('api_key_id = @api_key_id')
            params.api_key_id = apiKeyId
        }
        if (metadata !== undefined && metadata !== null) {
            updates.push('metadata = @metadata', 'metadata_version = metadata_version + 1', 'updated_at = @updated_at', 'seq = seq + 1')
            params.metadata = JSON.stringify(metadata)
            params.updated_at = Date.now()
        }
        if (updates.length > 0) {
            db.prepare(`UPDATE machines SET ${updates.join(', ')} WHERE id = @id`).run(params as any)
            return toStoredMachine(db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow)
        }
        return stored
    }

    const now = Date.now()
    const metadataJson = JSON.stringify(metadata)
    const runnerStateJson = runnerState === null || runnerState === undefined ? null : JSON.stringify(runnerState)

    db.prepare(`
        INSERT INTO machines (
            id, namespace, created_at, updated_at,
            metadata, metadata_version,
            runner_state, runner_state_version,
            active, active_at, seq,
            api_key_id
        ) VALUES (
            @id, @namespace, @created_at, @updated_at,
            @metadata, 1,
            @runner_state, 1,
            0, NULL, 0,
            @api_key_id
        )
    `).run({
        id,
        namespace,
        created_at: now,
        updated_at: now,
        metadata: metadataJson,
        runner_state: runnerStateJson,
        api_key_id: apiKeyId
    })

    const row = getMachine(db, id)
    if (!row) {
        throw new Error('Failed to create machine')
    }
    return row
}

export function updateMachineMetadata(
    db: Database,
    id: string,
    metadata: unknown,
    expectedVersion: number,
    namespace: string
): VersionedUpdateResult<unknown | null> {
    const now = Date.now()

    return updateVersionedField({
        db,
        table: 'machines',
        id,
        namespace,
        field: 'metadata',
        versionField: 'metadata_version',
        expectedVersion,
        value: metadata,
        encode: (value) => {
            const json = JSON.stringify(value)
            return json === undefined ? null : json
        },
        decode: safeJsonParse,
        setClauses: ['updated_at = @updated_at', 'seq = seq + 1'],
        params: { updated_at: now }
    })
}

export function updateMachineRunnerState(
    db: Database,
    id: string,
    runnerState: unknown,
    expectedVersion: number,
    namespace: string
): VersionedUpdateResult<unknown | null> {
    const now = Date.now()
    const normalized = runnerState ?? null

    return updateVersionedField({
        db,
        table: 'machines',
        id,
        namespace,
        field: 'runner_state',
        versionField: 'runner_state_version',
        expectedVersion,
        value: normalized,
        encode: (value) => (value === null ? null : JSON.stringify(value)),
        decode: safeJsonParse,
        setClauses: [
            'updated_at = @updated_at',
            'active = 1',
            'active_at = @active_at',
            'seq = seq + 1'
        ],
        params: { updated_at: now, active_at: now }
    })
}

export function getMachine(db: Database, id: string): StoredMachine | null {
    const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbMachineRow | undefined
    return row ? toStoredMachine(row) : null
}

export function getMachineByNamespace(db: Database, id: string, namespace: string): StoredMachine | null {
    const row = db.prepare(
        'SELECT * FROM machines WHERE id = ? AND namespace = ?'
    ).get(id, namespace) as DbMachineRow | undefined
    return row ? toStoredMachine(row) : null
}

export function getMachines(db: Database): StoredMachine[] {
    const rows = db.prepare('SELECT * FROM machines ORDER BY updated_at DESC').all() as DbMachineRow[]
    return rows.map(toStoredMachine)
}

export function getMachinesByNamespace(db: Database, namespace: string): StoredMachine[] {
    const rows = db.prepare(
        'SELECT * FROM machines WHERE namespace = ? ORDER BY updated_at DESC'
    ).all(namespace) as DbMachineRow[]
    return rows.map(toStoredMachine)
}

export function unbindMachine(db: Database, id: string): boolean {
    const result = db.prepare('UPDATE machines SET api_key_id = NULL WHERE id = ?').run(id)
    return result.changes > 0
}

export function deleteMachine(db: Database, id: string, namespace: string): boolean {
    const result = db.prepare('DELETE FROM machines WHERE id = ? AND namespace = ?').run(id, namespace)
    return result.changes > 0
}
