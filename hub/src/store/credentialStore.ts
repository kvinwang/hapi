import type { Database } from 'bun:sqlite'

import type { StoredCredential, StoredMachineCredential } from './types'
import { safeJsonParse } from './json'

type DbCredentialRow = {
    id: string
    namespace: string
    name: string
    agent_type: string
    config: string
    created_at: number
    updated_at: number
}

type DbMachineCredentialRow = {
    machine_id: string
    agent_type: string
    credential_id: string
    applied_at: number
}

function toStoredCredential(row: DbCredentialRow): StoredCredential {
    return {
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        agentType: row.agent_type,
        config: safeJsonParse(row.config),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export class CredentialStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    createCredential(params: {
        id: string
        namespace: string
        name: string
        agentType: string
        config: unknown
    }): StoredCredential {
        const now = Date.now()
        const configJson = JSON.stringify(params.config)

        this.db.prepare(`
            INSERT INTO credentials (id, namespace, name, agent_type, config, created_at, updated_at)
            VALUES (@id, @namespace, @name, @agent_type, @config, @created_at, @updated_at)
        `).run({
            id: params.id,
            namespace: params.namespace,
            name: params.name,
            agent_type: params.agentType,
            config: configJson,
            created_at: now,
            updated_at: now
        })

        const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(params.id) as DbCredentialRow
        return toStoredCredential(row)
    }

    updateCredential(
        id: string,
        namespace: string,
        params: { name?: string; config?: unknown }
    ): StoredCredential | null {
        const existing = this.db.prepare(
            'SELECT * FROM credentials WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as DbCredentialRow | undefined

        if (!existing) return null

        const now = Date.now()
        const setClauses: string[] = ['updated_at = @updated_at']
        const values: Record<string, unknown> = { updated_at: now, id, namespace }

        if (params.name !== undefined) {
            setClauses.push('name = @name')
            values.name = params.name
        }
        if (params.config !== undefined) {
            setClauses.push('config = @config')
            values.config = JSON.stringify(params.config)
        }

        this.db.prepare(
            `UPDATE credentials SET ${setClauses.join(', ')} WHERE id = @id AND namespace = @namespace`
        ).run(values as Record<string, string | number | null>)

        const row = this.db.prepare(
            'SELECT * FROM credentials WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as DbCredentialRow
        return toStoredCredential(row)
    }

    deleteCredential(id: string, namespace: string): boolean {
        const result = this.db.prepare(
            'DELETE FROM credentials WHERE id = ? AND namespace = ?'
        ).run(id, namespace)
        return result.changes > 0
    }

    getCredentialByNamespace(id: string, namespace: string): StoredCredential | null {
        const row = this.db.prepare(
            'SELECT * FROM credentials WHERE id = ? AND namespace = ?'
        ).get(id, namespace) as DbCredentialRow | undefined
        return row ? toStoredCredential(row) : null
    }

    getCredentialsByNamespace(namespace: string): StoredCredential[] {
        const rows = this.db.prepare(
            'SELECT * FROM credentials WHERE namespace = ? ORDER BY updated_at DESC'
        ).all(namespace) as DbCredentialRow[]
        return rows.map(toStoredCredential)
    }

    setMachineCredential(machineId: string, agentType: string, credentialId: string): void {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO machine_credentials (machine_id, agent_type, credential_id, applied_at)
            VALUES (@machine_id, @agent_type, @credential_id, @applied_at)
            ON CONFLICT(machine_id, agent_type)
            DO UPDATE SET credential_id = @credential_id, applied_at = @applied_at
        `).run({
            machine_id: machineId,
            agent_type: agentType,
            credential_id: credentialId,
            applied_at: now
        })
    }

    getMachineCredentialsByNamespace(machineId: string, namespace: string): StoredMachineCredential[] {
        const rows = this.db.prepare(`
            SELECT mc.* FROM machine_credentials mc
            JOIN credentials c ON mc.credential_id = c.id
            WHERE mc.machine_id = ? AND c.namespace = ?
        `).all(machineId, namespace) as DbMachineCredentialRow[]
        return rows.map(row => ({
            machineId: row.machine_id,
            agentType: row.agent_type,
            credentialId: row.credential_id,
            appliedAt: row.applied_at
        }))
    }
}
