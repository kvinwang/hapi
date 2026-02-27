import type { Database } from 'bun:sqlite'

import type { Permission, StoredAccessToken } from './types'
import { safeJsonParse } from './json'

type DbAccessTokenRow = {
    id: string
    api_key_id: string
    name: string
    token_hash: string
    token_prefix: string
    namespace: string
    permissions: string
    created_at: number
    expires_at: number
    revoked_at: number | null
}

function toStoredAccessToken(row: DbAccessTokenRow): StoredAccessToken {
    return {
        id: row.id,
        apiKeyId: row.api_key_id,
        name: row.name,
        tokenHash: row.token_hash,
        tokenPrefix: row.token_prefix,
        namespace: row.namespace,
        permissions: (safeJsonParse(row.permissions) ?? []) as Permission[],
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at
    }
}

export class AccessTokenStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    createToken(params: {
        id: string
        apiKeyId: string
        name: string
        tokenHash: string
        tokenPrefix: string
        namespace: string
        permissions: Permission[]
        expiresAt: number
    }): StoredAccessToken {
        const now = Date.now()
        const permissionsJson = JSON.stringify(params.permissions)

        this.db.prepare(`
            INSERT INTO access_tokens (id, api_key_id, name, token_hash, token_prefix, namespace, permissions, created_at, expires_at)
            VALUES (@id, @api_key_id, @name, @token_hash, @token_prefix, @namespace, @permissions, @created_at, @expires_at)
        `).run({
            id: params.id,
            api_key_id: params.apiKeyId,
            name: params.name,
            token_hash: params.tokenHash,
            token_prefix: params.tokenPrefix,
            namespace: params.namespace,
            permissions: permissionsJson,
            created_at: now,
            expires_at: params.expiresAt
        })

        const row = this.db.prepare('SELECT * FROM access_tokens WHERE id = ?').get(params.id) as DbAccessTokenRow
        return toStoredAccessToken(row)
    }

    getTokenByHash(tokenHash: string): StoredAccessToken | null {
        const row = this.db.prepare(
            'SELECT * FROM access_tokens WHERE token_hash = ?'
        ).get(tokenHash) as DbAccessTokenRow | undefined
        return row ? toStoredAccessToken(row) : null
    }

    getToken(id: string): StoredAccessToken | null {
        const row = this.db.prepare(
            'SELECT * FROM access_tokens WHERE id = ?'
        ).get(id) as DbAccessTokenRow | undefined
        return row ? toStoredAccessToken(row) : null
    }

    listTokensByApiKey(apiKeyId: string): StoredAccessToken[] {
        const rows = this.db.prepare(
            'SELECT * FROM access_tokens WHERE api_key_id = ? ORDER BY created_at DESC'
        ).all(apiKeyId) as DbAccessTokenRow[]
        return rows.map(toStoredAccessToken)
    }

    revokeToken(id: string): boolean {
        const now = Date.now()
        const result = this.db.prepare(
            'UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
        ).run(now, id)
        return result.changes > 0
    }

    revokeTokensByApiKey(apiKeyId: string): number {
        const now = Date.now()
        const result = this.db.prepare(
            'UPDATE access_tokens SET revoked_at = ? WHERE api_key_id = ? AND revoked_at IS NULL'
        ).run(now, apiKeyId)
        return result.changes
    }

    /** Get all revoked access token IDs that haven't expired yet (for cache rebuild) */
    getRevokedActiveIds(): string[] {
        const now = Date.now()
        const rows = this.db.prepare(
            'SELECT id FROM access_tokens WHERE revoked_at IS NOT NULL AND (expires_at = 0 OR expires_at > ?)'
        ).all(now) as Array<{ id: string }>
        return rows.map(row => row.id)
    }

    cleanupExpired(): number {
        const now = Date.now()
        const result = this.db.prepare(
            'DELETE FROM access_tokens WHERE expires_at > 0 AND expires_at < ?'
        ).run(now)
        return result.changes
    }
}
