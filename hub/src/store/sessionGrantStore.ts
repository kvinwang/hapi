import type { Database } from 'bun:sqlite'

/** Access-code grant rooted at one session, with optional collaboration scopes. */
export interface StoredSessionGrant {
    id: string
    sessionId: string
    namespace: string
    codeHash: string
    description: string | null
    allowVoice: boolean
    allowAgents: boolean
    threadIds: string[]
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
    description: string | null
    allow_voice: number
    allow_agents: number
    thread_ids: string
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
        description: row.description,
        allowVoice: row.allow_voice === 1,
        allowAgents: row.allow_agents === 1,
        threadIds: JSON.parse(row.thread_ids),
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
        description: string | null
        allowVoice: boolean
        allowAgents?: boolean
        threadIds?: string[]
        expiresAt: number
    }): StoredSessionGrant {
        this.db.prepare(`
            INSERT INTO session_grants (id, session_id, namespace, code_hash, description, allow_voice, allow_agents, thread_ids, created_at, expires_at)
            VALUES (@id, @session_id, @namespace, @code_hash, @description, @allow_voice, @allow_agents, @thread_ids, @created_at, @expires_at)
        `).run({
            id: params.id,
            session_id: params.sessionId,
            namespace: params.namespace,
            code_hash: params.codeHash,
            description: params.description,
            allow_voice: params.allowVoice ? 1 : 0,
            allow_agents: params.allowAgents ? 1 : 0,
            thread_ids: JSON.stringify(params.threadIds ?? []),
            created_at: Date.now(),
            expires_at: params.expiresAt
        })
        return this.get(params.id)!
    }

    get(id: string): StoredSessionGrant | null {
        const row = this.db.prepare('SELECT * FROM session_grants WHERE id = ?').get(id) as DbSessionGrantRow | undefined
        return row ? toStoredSessionGrant(row) : null
    }

    /** Unrevoked grants, expired ones included so that the owner can renew them. */
    listBySession(sessionId: string, namespace: string): StoredSessionGrant[] {
        const rows = this.db.prepare(`
            SELECT * FROM session_grants
            WHERE session_id = ? AND namespace = ? AND revoked_at IS NULL
            ORDER BY created_at DESC
        `).all(sessionId, namespace) as DbSessionGrantRow[]
        return rows.map(toStoredSessionGrant)
    }

    setAllowVoice(id: string, sessionId: string, namespace: string, allowVoice: boolean): StoredSessionGrant | null {
        const result = this.db.prepare(`
            UPDATE session_grants SET allow_voice = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(allowVoice ? 1 : 0, id, sessionId, namespace)
        return result.changes > 0 ? this.get(id) : null
    }

    setScope(id: string, sessionId: string, namespace: string, options: { allowVoice?: boolean; allowAgents?: boolean; threadIds?: string[] }): StoredSessionGrant | null {
        const current = this.get(id)
        if (!current || current.sessionId !== sessionId || current.namespace !== namespace || current.revokedAt !== null) return null
        this.db.prepare('UPDATE session_grants SET allow_voice = ?, allow_agents = ?, thread_ids = ? WHERE id = ?').run(
            Number(options.allowVoice ?? current.allowVoice), Number(options.allowAgents ?? current.allowAgents), JSON.stringify(options.threadIds ?? current.threadIds), id
        )
        return this.get(id)
    }

    renew(id: string, sessionId: string, namespace: string, expiresAt: number): StoredSessionGrant | null {
        const result = this.db.prepare(`
            UPDATE session_grants SET expires_at = ?
            WHERE id = ? AND session_id = ? AND namespace = ? AND revoked_at IS NULL
        `).run(expiresAt, id, sessionId, namespace)
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
