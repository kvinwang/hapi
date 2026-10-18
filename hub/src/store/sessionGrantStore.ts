import type { Database } from 'bun:sqlite'

/** A guest's access to a single session: an unguessable link id plus a short code. */
export interface StoredSessionGrant {
    id: string
    sessionId: string
    namespace: string
    codeHash: string
    allowVoice: boolean
    failedAttempts: number
    createdAt: number
    expiresAt: number
    revokedAt: number | null
}

type DbSessionGrantRow = {
    id: string
    session_id: string
    namespace: string
    code_hash: string
    allow_voice: number
    failed_attempts: number
    created_at: number
    expires_at: number
    revoked_at: number | null
}

function toStoredSessionGrant(row: DbSessionGrantRow): StoredSessionGrant {
    return {
        id: row.id,
        sessionId: row.session_id,
        namespace: row.namespace,
        codeHash: row.code_hash,
        allowVoice: row.allow_voice === 1,
        failedAttempts: row.failed_attempts,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at
    }
}

export function isSessionGrantUsable(grant: StoredSessionGrant, now: number = Date.now()): boolean {
    return grant.revokedAt === null && grant.expiresAt > now
}

export class SessionGrantStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    create(params: {
        id: string
        sessionId: string
        namespace: string
        codeHash: string
        allowVoice: boolean
        expiresAt: number
    }): StoredSessionGrant {
        this.db.prepare(`
            INSERT INTO session_grants (id, session_id, namespace, code_hash, allow_voice, created_at, expires_at)
            VALUES (@id, @session_id, @namespace, @code_hash, @allow_voice, @created_at, @expires_at)
        `).run({
            id: params.id,
            session_id: params.sessionId,
            namespace: params.namespace,
            code_hash: params.codeHash,
            allow_voice: params.allowVoice ? 1 : 0,
            created_at: Date.now(),
            expires_at: params.expiresAt
        })
        return this.get(params.id)!
    }

    get(id: string): StoredSessionGrant | null {
        const row = this.db.prepare('SELECT * FROM session_grants WHERE id = ?').get(id) as DbSessionGrantRow | undefined
        return row ? toStoredSessionGrant(row) : null
    }

    listUsableBySession(sessionId: string, namespace: string): StoredSessionGrant[] {
        const rows = this.db.prepare(`
            SELECT * FROM session_grants
            WHERE session_id = ? AND namespace = ? AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC
        `).all(sessionId, namespace, Date.now()) as DbSessionGrantRow[]
        return rows.map(toStoredSessionGrant)
    }

    setAllowVoice(id: string, sessionId: string, namespace: string, allowVoice: boolean): StoredSessionGrant | null {
        const result = this.db.prepare(`
            UPDATE session_grants SET allow_voice = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(allowVoice ? 1 : 0, id, sessionId, namespace)
        return result.changes > 0 ? this.get(id) : null
    }

    revoke(id: string, sessionId: string, namespace: string): boolean {
        const result = this.db.prepare(`
            UPDATE session_grants SET revoked_at = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(Date.now(), id, sessionId, namespace)
        return result.changes > 0
    }

    /** Counts a wrong code; the grant is revoked once `maxAttempts` is reached. */
    recordFailedAttempt(id: string, maxAttempts: number): void {
        this.db.prepare(`
            UPDATE session_grants
            SET failed_attempts = failed_attempts + 1,
                revoked_at = CASE WHEN failed_attempts + 1 >= @max THEN @now ELSE revoked_at END
            WHERE id = @id AND revoked_at IS NULL
        `).run({ id, max: maxAttempts, now: Date.now() })
    }
}
