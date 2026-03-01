import type { Database } from 'bun:sqlite'

export class PreferenceStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    get(namespace: string, key: string): string | null {
        const row = this.db.prepare(
            'SELECT value FROM preferences WHERE namespace = ? AND key = ?'
        ).get(namespace, key) as { value: string | null } | undefined
        return row?.value ?? null
    }

    set(namespace: string, key: string, value: string | null): void {
        if (value === null) {
            this.db.prepare(
                'DELETE FROM preferences WHERE namespace = ? AND key = ?'
            ).run(namespace, key)
        } else {
            this.db.prepare(`
                INSERT INTO preferences (namespace, key, value, updated_at)
                VALUES (@namespace, @key, @value, @updated_at)
                ON CONFLICT(namespace, key) DO UPDATE
                SET value = @value, updated_at = @updated_at
            `).run({
                namespace,
                key,
                value,
                updated_at: Date.now()
            })
        }
    }
}
