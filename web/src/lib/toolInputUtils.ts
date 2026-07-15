import { isObject } from '@hapi/protocol'

export function getInputString(input: unknown, key: string): string | null {
    if (!isObject(input) || Array.isArray(input)) return null
    const value = input[key]
    return typeof value === 'string' ? value : null
}

export function getInputStringAny(input: unknown, keys: string[]): string | null {
    for (const key of keys) {
        const value = getInputString(input, key)
        if (value) return value
    }
    return null
}

export function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

/**
 * Normalize shell command text for display:
 * - real newlines preserved
 * - literal "\\n" sequences (from double-encoded JSON) → real newlines when
 *   they look like intentional multi-line scripts (heredoc / several breaks)
 */
export function normalizeShellCommand(command: string): string {
    let text = command.replace(/\r\n?/g, '\n')
    // Only rewrite escaped newlines when the string has no real newlines yet,
    // but clearly intended multi-line content (heredoc or multiple \n markers).
    if (!text.includes('\n') && /\\n/.test(text)) {
        const escapedCount = (text.match(/\\n/g) ?? []).length
        if (escapedCount >= 1 && (text.includes("<<'") || text.includes('<<"') || text.includes('<<EOF') || escapedCount >= 2)) {
            text = text.replace(/\\n/g, '\n')
        }
    }
    return text
}

/**
 * Collapse multi-line shell commands for card subtitles so they stay scannable.
 * Full command stays available in the expanded input CodeBlock.
 */
export function formatCommandSubtitle(command: string, maxLen: number = 160): string {
    const normalized = normalizeShellCommand(command).trimEnd()
    if (!normalized) return command

    const lines = normalized.split('\n')
    const first = lines[0]?.trim() ?? ''
    const extraLines = lines.length - 1

    let subtitle = first
    if (extraLines > 0) {
        subtitle = `${first}  …(+${extraLines} line${extraLines === 1 ? '' : 's'})`
    }
    return truncate(subtitle, maxLen)
}

/** Known shell tool names across Claude / Codex / Grok. */
const SHELL_TOOL_NAMES = new Set([
    'bash',
    'shell',
    'shell_command',
    'codexbash',
    'run_terminal_command',
    'run_terminal_cmd',
    'terminal'
])

/**
 * Grok/ACP often names shell tools `Execute \`cmd...\`` with
 * `input: { variant: "Bash", command: "..." }`. Detect those too.
 */
export function isShellToolCall(toolName: string, input?: unknown): boolean {
    const name = toolName.trim()
    const lower = name.toLowerCase()
    if (SHELL_TOOL_NAMES.has(lower)) return true
    if (lower.startsWith('execute `') || lower.startsWith('execute "') || lower.startsWith("execute '")) {
        return true
    }
    if (lower.startsWith('bash(') || lower.startsWith('shell(')) return true

    if (isObject(input) && !Array.isArray(input)) {
        const variant = typeof input.variant === 'string' ? input.variant.toLowerCase() : ''
        if (variant === 'bash' || variant === 'shell') return true
        // Grok/Codex often put the real command in input.command even when the
        // tool name is a long `Execute \`...\`` display string.
        if (
            typeof input.command === 'string'
            && input.command.length > 0
            && (
                lower.includes('bash')
                || lower.includes('shell')
                || lower.includes('terminal')
                || lower.startsWith('execute')
                || lower.startsWith('run_')
            )
        ) {
            return true
        }
    }
    return false
}

/** Extract the shell command string from common tool input shapes. */
export function getShellCommand(input: unknown): string | null {
    if (!isObject(input) || Array.isArray(input)) return null

    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return normalizeShellCommand(direct)

    if (Array.isArray(input.command)) {
        const parts = input.command.filter((part): part is string => typeof part === 'string')
        if (parts.length > 0) return normalizeShellCommand(parts.join('\n'))
    }

    return null
}
