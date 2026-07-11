export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number]

export const CODEX_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type CodexPermissionMode = typeof CODEX_PERMISSION_MODES[number]

export const GEMINI_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const
export type GeminiPermissionMode = typeof GEMINI_PERMISSION_MODES[number]

export const OPENCODE_PERMISSION_MODES = ['default', 'yolo'] as const
export type OpencodePermissionMode = typeof OPENCODE_PERMISSION_MODES[number]

export const CURSOR_PERMISSION_MODES = ['default', 'plan', 'ask', 'yolo'] as const
export type CursorPermissionMode = typeof CURSOR_PERMISSION_MODES[number]

/** Grok Build permission modes (mirrors `grok --permission-mode` names). */
export const GROK_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type GrokPermissionMode = typeof GROK_PERMISSION_MODES[number]

export const PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'ask',
    'read-only',
    'safe-yolo',
    'yolo'
] as const
export type PermissionMode = typeof PERMISSION_MODES[number]

/**
 * Well-known Claude model aliases, used as the static fallback list for UI pickers
 * and keyboard cycling when no dynamically detected model list is available.
 */
export const MODEL_MODES = ['default', 'sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable', 'fable[1m]'] as const
export type KnownModelMode = typeof MODEL_MODES[number]
/**
 * A Claude model mode. 'default' means "let Claude Code pick" (no --model flag);
 * any other value is passed verbatim to `claude --model`, so dynamically detected
 * aliases/ids (e.g. 'claude-fable-5[1m]') are allowed in addition to MODEL_MODES.
 */
export type ModelMode = string

export type AgentFlavor = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'grok'

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    plan: 'Plan Mode',
    ask: 'Ask Mode',
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo'
}

export type PermissionModeTone = 'neutral' | 'info' | 'warning' | 'danger'

export const PERMISSION_MODE_TONES: Record<PermissionMode, PermissionModeTone> = {
    default: 'neutral',
    acceptEdits: 'warning',
    plan: 'info',
    ask: 'info',
    bypassPermissions: 'danger',
    'read-only': 'warning',
    'safe-yolo': 'warning',
    yolo: 'danger'
}

export type PermissionModeOption = {
    mode: PermissionMode
    label: string
    tone: PermissionModeTone
}

export const MODEL_MODE_LABELS: Record<KnownModelMode, string> = {
    default: 'Default',
    sonnet: 'Sonnet',
    'sonnet[1m]': 'Sonnet 1M',
    opus: 'Opus',
    'opus[1m]': 'Opus 1M',
    fable: 'Fable',
    'fable[1m]': 'Fable 1M'
}

export function getModelModeLabel(mode: ModelMode): string {
    return (MODEL_MODE_LABELS as Record<string, string>)[mode] ?? mode
}

export function getPermissionModeLabel(mode: PermissionMode): string {
    return PERMISSION_MODE_LABELS[mode]
}

export function getPermissionModeTone(mode: PermissionMode): PermissionModeTone {
    return PERMISSION_MODE_TONES[mode]
}

export function getPermissionModesForFlavor(flavor?: string | null): readonly PermissionMode[] {
    if (flavor === 'codex') {
        return CODEX_PERMISSION_MODES
    }
    if (flavor === 'gemini') {
        return GEMINI_PERMISSION_MODES
    }
    if (flavor === 'opencode') {
        return OPENCODE_PERMISSION_MODES
    }
    if (flavor === 'cursor') {
        return CURSOR_PERMISSION_MODES
    }
    if (flavor === 'grok') {
        return GROK_PERMISSION_MODES
    }
    return CLAUDE_PERMISSION_MODES
}

export function getPermissionModeOptionsForFlavor(flavor?: string | null): PermissionModeOption[] {
    return getPermissionModesForFlavor(flavor).map((mode) => ({
        mode,
        label: getPermissionModeLabel(mode),
        tone: getPermissionModeTone(mode)
    }))
}

export function isPermissionModeAllowedForFlavor(mode: PermissionMode, flavor?: string | null): boolean {
    return getPermissionModesForFlavor(flavor).includes(mode)
}

/** Static model picker options for Grok Build (ids accepted by `grok --model` / ACP set_model). */
export const GROK_MODEL_MODES = ['auto', 'grok-4.5', 'grok-composer-2.5-fast'] as const

/** Static model picker options for Codex (passed to app-server / turn start). */
export const CODEX_MODEL_MODES = [
    'auto',
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini'
] as const

/**
 * Reasoning effort levels.
 * - Claude CLI: `--effort low|medium|high|xhigh|max`
 * - Codex app-server: `effort: low|medium|high|auto`
 * - Grok ACP: `session/set_mode` with modeId low|medium|high
 */
export const EFFORT_MODES = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const
export type EffortMode = typeof EFFORT_MODES[number]

export const EFFORT_MODE_LABELS: Record<EffortMode, string> = {
    default: 'Default',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
    auto: 'Auto'
}

export function getEffortModeLabel(mode: EffortMode | string): string {
    return (EFFORT_MODE_LABELS as Record<string, string>)[mode] ?? mode
}

export function getEffortModesForFlavor(flavor?: string | null): readonly EffortMode[] {
    if (flavor === 'claude') {
        return ['default', 'low', 'medium', 'high', 'xhigh', 'max']
    }
    if (flavor === 'codex') {
        return ['default', 'low', 'medium', 'high', 'auto']
    }
    if (flavor === 'grok') {
        return ['default', 'low', 'medium', 'high']
    }
    return []
}

export function isEffortModeAllowedForFlavor(mode: EffortMode | string, flavor?: string | null): boolean {
    return getEffortModesForFlavor(flavor).includes(mode as EffortMode)
}

export function getModelModesForFlavor(flavor?: string | null): readonly ModelMode[] {
    if (flavor === 'grok') {
        return GROK_MODEL_MODES
    }
    if (flavor === 'codex') {
        return CODEX_MODEL_MODES
    }
    if (flavor === 'gemini' || flavor === 'opencode' || flavor === 'cursor') {
        return []
    }
    return MODEL_MODES
}

export function isModelModeAllowedForFlavor(mode: ModelMode, flavor?: string | null): boolean {
    // Claude, Grok, Codex accept any non-empty model alias/id.
    if (flavor === 'claude' || flavor === 'grok' || flavor === 'codex' || !flavor) {
        return typeof mode === 'string' && mode.length > 0
    }
    if (getModelModesForFlavor(flavor).length === 0) {
        return false
    }
    return getModelModesForFlavor(flavor).includes(mode)
}
