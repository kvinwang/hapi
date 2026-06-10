import type { SessionModelMode } from '@/api/types'

/**
 * Resolve the model option passed at session start into a session model mode.
 *
 * Any non-empty model alias/id (e.g. 'opus', 'fable', 'sonnet[1m]', or a dynamically
 * detected id like 'claude-fable-5[1m]') is passed through verbatim — Claude Code
 * validates it via `--model`. 'auto' and 'default' both mean "let Claude Code pick"
 * and resolve to 'default' (no --model flag).
 */
export function resolveClaudeSessionModelMode(model?: string): SessionModelMode {
    const trimmed = model?.trim()
    if (!trimmed || trimmed === 'auto' || trimmed === 'default') {
        return 'default'
    }

    return trimmed
}
