const STOP_HOOK_FEEDBACK_MARKER = 'Stop hook feedback:'

/** Claude injects blocked Stop-hook output back into the conversation with this marker. */
export function isClaudeStopHookFeedback(text: string): boolean {
    return text.startsWith(STOP_HOOK_FEEDBACK_MARKER)
}
