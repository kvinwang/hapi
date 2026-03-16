import type { Database } from 'bun:sqlite'

import type { Permission, StoredApiKey } from './types'
import { safeJsonParse } from './json'

type DbApiKeyRow = {
    id: string
    name: string
    key_hash: string
    key_prefix: string
    namespace: string
    permissions: string
    created_at: number
    revoked_at: number | null
    last_used_at: number | null
}

function toStoredApiKey(row: DbApiKeyRow): StoredApiKey {
    return {
        id: row.id,
        name: row.name,
        keyHash: row.key_hash,
        keyPrefix: row.key_prefix,
        namespace: row.namespace,
        permissions: (safeJsonParse(row.permissions) ?? []) as Permission[],
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at
    }
}

export class ApiKeyStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    createApiKey(params: {
        id: string
        name: string
        keyHash: string
        keyPrefix: string
        namespace: string
        permissions: Permission[]
    }): StoredApiKey {
        const now = Date.now()
        const permissionsJson = JSON.stringify(params.permissions)

        this.db.prepare(`
            INSERT INTO api_keys (id, name, key_hash, key_prefix, namespace, permissions, created_at)
            VALUES (@id, @name, @key_hash, @key_prefix, @namespace, @permissions, @created_at)
        `).run({
            id: params.id,
            name: params.name,
            key_hash: params.keyHash,
            key_prefix: params.keyPrefix,
            namespace: params.namespace,
            permissions: permissionsJson,
            created_at: now
        })

        const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(params.id) as DbApiKeyRow
        return toStoredApiKey(row)
    }

    getApiKeyByHash(keyHash: string): StoredApiKey | null {
        const row = this.db.prepare(
            'SELECT * FROM api_keys WHERE key_hash = ?'
        ).get(keyHash) as DbApiKeyRow | undefined
        return row ? toStoredApiKey(row) : null
    }

    getApiKeyById(id: string): StoredApiKey | null {
        const row = this.db.prepare(
            'SELECT * FROM api_keys WHERE id = ?'
        ).get(id) as DbApiKeyRow | undefined
        return row ? toStoredApiKey(row) : null
    }

    listApiKeys(): StoredApiKey[] {
        const rows = this.db.prepare(
            'SELECT * FROM api_keys ORDER BY created_at DESC'
        ).all() as DbApiKeyRow[]
        return rows.map(toStoredApiKey)
    }

    revokeApiKey(id: string): boolean {
        const now = Date.now()
        const result = this.db.prepare(
            'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
        ).run(now, id)
        return result.changes > 0
    }

    restoreApiKey(id: string): boolean {
        const result = this.db.prepare(
            'UPDATE api_keys SET revoked_at = NULL WHERE id = ? AND revoked_at IS NOT NULL'
        ).run(id)
        return result.changes > 0
    }

    updatePermissions(id: string, permissions: Permission[]): StoredApiKey | null {
        const permissionsJson = JSON.stringify(permissions)
        const result = this.db.prepare(
            'UPDATE api_keys SET permissions = ? WHERE id = ? AND revoked_at IS NULL'
        ).run(permissionsJson, id)
        if (result.changes === 0) return null
        return this.getApiKeyById(id)
    }

    updateApiKey(id: string, params: { name?: string; permissions?: Permission[] }): StoredApiKey | null {
        const updates: string[] = []
        const values: (string | number)[] = []
        if (params.name !== undefined) {
            updates.push('name = ?')
            values.push(params.name)
        }
        if (params.permissions !== undefined) {
            updates.push('permissions = ?')
            values.push(JSON.stringify(params.permissions))
        }
        if (updates.length === 0) return this.getApiKeyById(id)
        values.push(id)
        const result = this.db.prepare(
            `UPDATE api_keys SET ${updates.join(', ')} WHERE id = ? AND revoked_at IS NULL`
        ).run(...values)
        if (result.changes === 0) return null
        return this.getApiKeyById(id)
    }

    updateLastUsed(id: string): void {
        const now = Date.now()
        this.db.prepare(
            'UPDATE api_keys SET last_used_at = ? WHERE id = ?'
        ).run(now, id)
    }
}
