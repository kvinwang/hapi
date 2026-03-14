/**
 * Context windows vary by model/provider and may change over time.
 *
 * We derive the context window from the actual model string returned by the API
 * (e.g. "claude-opus-4-6[1m]") so new models are automatically handled
 * without hardcoding every variant.
 */
const CONTEXT_HEADROOM_TOKENS = 10_000

/**
 * Known context window sizes by model pattern.
 * Patterns are matched in order; first match wins.
 * The `test` function receives the full model ID string.
 */
const MODEL_CONTEXT_RULES: { test: (model: string) => boolean; tokens: number }[] = [
    // Models with explicit context window suffix, e.g. "claude-opus-4-6[1m]"
    { test: (m) => /\[1m\]/i.test(m), tokens: 1_000_000 },
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

export function getContextBudgetTokens(model: string | undefined): number {
    const windowTokens = getContextWindowForModel(model)
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
