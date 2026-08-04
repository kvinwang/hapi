import type { AgentFlavor, Metadata } from '@hapi/protocol/types'

/**
 * Where each agent stores the handle to its own transcript.
 *
 * These are independent slots: a session handed between agents accumulates one per agent that has
 * driven it, and each is what lets that agent resume its own thread rather than starting cold.
 */
export const AGENT_SESSION_ID_FIELDS: Record<AgentFlavor, keyof Metadata & string> = {
    claude: 'claudeSessionId',
    codex: 'codexSessionId',
    gemini: 'geminiSessionId',
    opencode: 'opencodeSessionId',
    cursor: 'cursorSessionId',
    grok: 'grokSessionId'
}

export const AGENT_FLAVORS: AgentFlavor[] = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'opencode']

export function normalizeAgentFlavor(flavor: string | null | undefined): AgentFlavor {
    return AGENT_FLAVORS.includes(flavor as AgentFlavor) ? flavor as AgentFlavor : 'claude'
}

export function getAgentResumeToken(metadata: Metadata, flavor: AgentFlavor): string | undefined {
    const value = metadata[AGENT_SESSION_ID_FIELDS[flavor]]
    return typeof value === 'string' && value ? value : undefined
}
