import type { SessionModelMode } from '@/api/types'

const CLAUDE_SESSION_MODEL_MODES = new Set<SessionModelMode>([
    'sonnet',
    'sonnet[1m]',
    'opus',
    'opus[1m]'
])

export function resolveClaudeSessionModelMode(model?: string): SessionModelMode {
    if (!model) {
        return 'default'
    }

    return CLAUDE_SESSION_MODEL_MODES.has(model as SessionModelMode)
        ? model as SessionModelMode
        : 'default'
}
