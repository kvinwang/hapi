/**
 * Context windows vary by model/provider and may change over time.
 *
 * Preference order:
 * 1. Explicit window size from the agent (e.g. Grok ACP `totalContextTokens`)
 * 2. Pattern heuristics from the model id string
 * 3. Default 200k
 */
const CONTEXT_HEADROOM_TOKENS = 10_000

/**
 * Known context window sizes by model pattern (fallback when agent does not report size).
 * Patterns are matched in order; first match wins.
 */
const MODEL_CONTEXT_RULES: { test: (model: string) => boolean; tokens: number }[] = [
    // Models with explicit context window suffix, e.g. "claude-opus-4-6[1m]"
    { test: (m) => /\[1m\]/i.test(m), tokens: 1_000_000 },
    // Grok Build frontier model — 500k context (static fallback)
    { test: (m) => /grok-4\.5|grok-4-5|grok-build/i.test(m), tokens: 500_000 },
    // Composer / other Grok catalog models — 200k
    { test: (m) => /grok-composer|composer-2/i.test(m), tokens: 200_000 },
    // Codex / GPT-5.x family — typically ~272k context window
    { test: (m) => /gpt-5|codex/i.test(m), tokens: 272_000 },
    // All other models default to 200k
    { test: () => true, tokens: 200_000 },
]

const DEFAULT_CONTEXT_TOKENS = 200_000

function getContextWindowForModel(model: string | undefined): number {
    if (!model) return DEFAULT_CONTEXT_TOKENS
    for (const rule of MODEL_CONTEXT_RULES) {
        if (rule.test(model)) return rule.tokens
    }
    return DEFAULT_CONTEXT_TOKENS
}

export function getContextBudgetTokens(
    model: string | undefined,
    options?: { windowTokens?: number | null }
): number {
    const reported = options?.windowTokens
    const windowTokens = typeof reported === 'number' && reported > 0
        ? reported
        : getContextWindowForModel(model)
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
