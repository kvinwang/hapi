export function isCodexFamilyFlavor(flavor?: string | null): boolean {
    return flavor === 'codex' || flavor === 'gemini' || flavor === 'opencode' || flavor === 'grok'
}

export function isClaudeFlavor(flavor?: string | null): boolean {
    return flavor === 'claude'
}

export function isCursorFlavor(flavor?: string | null): boolean {
    return flavor === 'cursor'
}

export function isGrokFlavor(flavor?: string | null): boolean {
    return flavor === 'grok'
}

export function supportsModelModeSwitch(flavor?: string | null): boolean {
    return isClaudeFlavor(flavor) || isGrokFlavor(flavor) || flavor === 'codex'
}

export function supportsEffortMode(flavor?: string | null): boolean {
    return isClaudeFlavor(flavor) || isGrokFlavor(flavor) || flavor === 'codex'
}

export function isKnownFlavor(flavor?: string | null): boolean {
    return isClaudeFlavor(flavor) || isCodexFamilyFlavor(flavor) || isCursorFlavor(flavor)
}
