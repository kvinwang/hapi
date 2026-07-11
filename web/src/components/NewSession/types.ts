export type AgentType = 'claude' | 'codex' | 'cursor' | 'gemini' | 'grok' | 'opencode'
export type SessionType = 'simple' | 'worktree'

export const MODEL_OPTIONS: Record<AgentType, { value: string; label: string }[]> = {
    claude: [
        { value: 'auto', label: 'Auto' },
        { value: 'fable', label: 'Fable' },
        { value: 'fable[1m]', label: 'Fable 1M' },
        { value: 'opus', label: 'Opus' },
        { value: 'opus[1m]', label: 'Opus 1M' },
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'sonnet[1m]', label: 'Sonnet 1M' },
    ],
    codex: [
        { value: 'auto', label: 'Auto' },
        { value: 'gpt-5.4', label: 'GPT-5.4' },
        { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
        { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
        { value: 'gpt-5.2', label: 'GPT-5.2' },
        { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
        { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    ],
    cursor: [],
    gemini: [
        { value: 'auto', label: 'Auto' },
        { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    grok: [
        { value: 'auto', label: 'Auto' },
        { value: 'grok-4.5', label: 'Grok 4.5' },
        { value: 'grok-composer-2.5-fast', label: 'Composer 2.5 Fast' },
    ],
    opencode: [],
}
