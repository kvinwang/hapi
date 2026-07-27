import type { Database } from 'bun:sqlite'

export type GoalHistoryEntry = {
    objective: string
    tokenBudget: number | null
    useCount: number
    createdAt: number
    usedAt: number
}

type GoalHistoryRow = {
    objective: string
    token_budget: number | null
    use_count: number
    created_at: number
    used_at: number
}

const MAX_ENTRIES_PER_NAMESPACE = 50
const DEFAULT_LIST_LIMIT = 20

function fromRow(row: GoalHistoryRow): GoalHistoryEntry {
    return {
        objective: row.objective,
        tokenBudget: row.token_budget,
        useCount: row.use_count,
        createdAt: row.created_at,
        usedAt: row.used_at
    }
}

/**
 * Remembers the goals an account has used before so the goal editor can offer them again.
 * Entries are deduplicated by objective text and capped per namespace.
 */
export class GoalHistoryStore {
    constructor(private readonly db: Database) {}

    list(namespace: string, limit: number = DEFAULT_LIST_LIMIT): GoalHistoryEntry[] {
        const capped = Math.max(1, Math.min(limit, MAX_ENTRIES_PER_NAMESPACE))
        return (this.db.prepare(
            `SELECT objective, token_budget, use_count, created_at, used_at
             FROM goal_history WHERE namespace = ?
             ORDER BY used_at DESC LIMIT ?`
        ).all(namespace, capped) as GoalHistoryRow[]).map(fromRow)
    }

    record(namespace: string, goal: { objective: string; tokenBudget?: number | null }): GoalHistoryEntry | null {
        const objective = goal.objective.trim()
        if (!objective) return null
        // Keep used_at strictly increasing so goals recorded within the same millisecond stay ordered.
        const latest = this.db.prepare(
            'SELECT MAX(used_at) AS latest FROM goal_history WHERE namespace = ?'
        ).get(namespace) as { latest: number | null } | undefined
        const now = Math.max(Date.now(), (latest?.latest ?? 0) + 1)
        const tokenBudget = typeof goal.tokenBudget === 'number' ? goal.tokenBudget : null
        this.db.prepare(`
            INSERT INTO goal_history (namespace, objective, token_budget, use_count, created_at, used_at)
            VALUES (?, ?, ?, 1, ?, ?)
            ON CONFLICT(namespace, objective) DO UPDATE SET
                token_budget = excluded.token_budget,
                use_count = use_count + 1,
                used_at = excluded.used_at
        `).run(namespace, objective, tokenBudget, now, now)
        this.prune(namespace)
        const row = this.db.prepare(
            `SELECT objective, token_budget, use_count, created_at, used_at
             FROM goal_history WHERE namespace = ? AND objective = ?`
        ).get(namespace, objective) as GoalHistoryRow | undefined
        return row ? fromRow(row) : null
    }

    delete(namespace: string, objective: string): boolean {
        return this.db.prepare(
            'DELETE FROM goal_history WHERE namespace = ? AND objective = ?'
        ).run(namespace, objective).changes > 0
    }

    private prune(namespace: string): void {
        this.db.prepare(`
            DELETE FROM goal_history
            WHERE namespace = ? AND objective NOT IN (
                SELECT objective FROM goal_history WHERE namespace = ?
                ORDER BY used_at DESC LIMIT ?
            )
        `).run(namespace, namespace, MAX_ENTRIES_PER_NAMESPACE)
    }
}
