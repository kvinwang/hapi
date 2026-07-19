import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type RawClaudeGoal = {
    objective: string
    status: 'active' | 'paused' | 'budget_limited' | 'complete'
    token_budget: number | null
    tokens_used: number
    current_time_used_seconds: number
    created_at: number
    updated_at: number
}

export type ClaudeGoal = {
    objective: string
    status: 'active' | 'paused' | 'budgetLimited' | 'complete'
    tokenBudget: number | null
    tokensUsed: number | null
    timeUsedSeconds: number
    createdAt: number
    updatedAt: number
    source: 'claude-goal'
}

export class ClaudeGoalAdapter {
    readonly scriptPath = join(homedir(), '.claude', 'skills', 'goal', 'scripts', 'claude_goal.py')

    constructor(private readonly sessionId: string) {}

    isAvailable(): boolean {
        return existsSync(this.scriptPath)
    }

    private async run(args: string[]): Promise<string> {
        if (!this.isAvailable()) throw new Error('claude-goal is not installed')
        const { stdout } = await execFileAsync('python3', [this.scriptPath, ...args], {
            env: { ...process.env, CLAUDE_GOAL_SESSION_ID: this.sessionId },
            timeout: 30_000,
            maxBuffer: 1024 * 1024
        })
        return stdout.trim()
    }

    async get(): Promise<ClaudeGoal | null> {
        const output = await this.run(['json', '--session-id', this.sessionId])
        if (!output || output === 'null') return null
        const raw = JSON.parse(output) as RawClaudeGoal
        return {
            objective: raw.objective,
            status: raw.status === 'budget_limited' ? 'budgetLimited' : raw.status,
            tokenBudget: raw.token_budget,
            // claude-goal documents this counter as unavailable/soft today.
            tokensUsed: raw.tokens_used || null,
            timeUsedSeconds: raw.current_time_used_seconds,
            createdAt: raw.created_at * 1000,
            updatedAt: raw.updated_at * 1000,
            source: 'claude-goal'
        }
    }

    async set(input: { objective?: string; status?: string; tokenBudget?: number | null }): Promise<ClaudeGoal> {
        const current = await this.get()
        const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
        const replacesGoal = Boolean(objective) && (
            objective !== current?.objective ||
            (input.tokenBudget !== undefined && input.tokenBudget !== current?.tokenBudget)
        )
        if (replacesGoal) {
            if (current) await this.run(['clear'])
            const args = ['set']
            if (typeof input.tokenBudget === 'number') args.push('--tokens', String(input.tokenBudget))
            args.push(objective)
            await this.run(args)
        } else if (!current) {
            throw new Error('Goal objective is required')
        }

        if (input.status) {
            const command = input.status === 'budgetLimited' ? null : input.status
            if (command === 'active') await this.run(['resume'])
            else if (command === 'paused') await this.run(['pause'])
            else if (command === 'complete') await this.run(['complete'])
            else if (input.status !== (await this.get())?.status) throw new Error(`claude-goal does not support status: ${input.status}`)
        }
        const goal = await this.get()
        if (!goal) throw new Error('claude-goal did not persist the goal')
        return goal
    }

    async clear(): Promise<boolean> {
        const existed = await this.get() !== null
        if (existed) await this.run(['clear'])
        return existed
    }
}
