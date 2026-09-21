import type { PiPermissionMode } from '@hapi/protocol/types'

export type PermissionMode = PiPermissionMode

export interface PiMode {
    permissionMode: PermissionMode
    model?: string
    effort?: string
    appendSystemPrompt?: string
}

export type PiProviderConfig = {
    provider: string
    model: string
    apiKey?: string
    baseUrl?: string
    api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'
    protocol?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'
    headers?: Record<string, string>
    contextWindow?: number
    maxTokens?: number
}
