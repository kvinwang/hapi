import type { Database } from 'bun:sqlite'

export interface StoredInvite {
    id: string
    code: string
    namespace: string
    createdBy: string
    createdAt: number
    expiresAt: number
    redeemedAt: number | null
    redeemedBy: string | null
}

type DbInviteRow = {
    id: string
    code: string
    namespace: string
    created_by: string
    created_at: number
    expires_at: number
    redeemed_at: number | null
    redeemed_by: string | null
}

function toStoredInvite(row: DbInviteRow): StoredInvite {
    return {
        id: row.id,
        code: row.code,
        namespace: row.namespace,
        createdBy: row.created_by,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        redeemedAt: row.redeemed_at,
        redeemedBy: row.redeemed_by
    }
}

export class InviteStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    create(params: {
        id: string
        code: string
        namespace: string
        createdBy: string
        expiresAt: number
    }): StoredInvite {
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO invites (id, code, namespace, created_by, created_at, expires_at)
            VALUES (@id, @code, @namespace, @created_by, @created_at, @expires_at)
        `).run({
            id: params.id,
            code: params.code,
            namespace: params.namespace,
            created_by: params.createdBy,
            created_at: now,
            expires_at: params.expiresAt
        })

        return {
            id: params.id,
            code: params.code,
            namespace: params.namespace,
            createdBy: params.createdBy,
            createdAt: now,
            expiresAt: params.expiresAt,
            redeemedAt: null,
            redeemedBy: null
        }
    }

    getByCode(code: string): StoredInvite | null {
        const row = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as DbInviteRow | undefined
        return row ? toStoredInvite(row) : null
    }

    redeem(code: string, redeemedBy: string): StoredInvite | null {
        const now = Date.now()
        const result = this.db.prepare(`
            UPDATE invites SET redeemed_at = @now, redeemed_by = @redeemed_by
            WHERE code = @code AND redeemed_at IS NULL AND expires_at > @now
        `).run({ code, now, redeemed_by: redeemedBy })

        if (result.changes === 0) return null
        return this.getByCode(code)
    }

    listByNamespace(namespace: string): StoredInvite[] {
        const rows = this.db.prepare(
            'SELECT * FROM invites WHERE namespace = ? ORDER BY created_at DESC'
        ).all(namespace) as DbInviteRow[]
        return rows.map(toStoredInvite)
    }

    cleanupExpired(): number {
        const now = Date.now()
        const result = this.db.prepare(
            'DELETE FROM invites WHERE expires_at < ? AND redeemed_at IS NOT NULL'
        ).run(now)
        return result.changes
    }
}
