import { describe, expect, it } from 'vitest'
import type { CredentialConfig } from '@hapi/protocol'
import { claudeSettings } from './adapters'

const config: CredentialConfig = {
    provider: 'gateway',
    apiKey: 'synthetic-key',
    endpoints: { 'anthropic-messages': 'https://gateway.invalid/anthropic' },
    models: [{ id: 'model-a', contextWindow: 1_048_576 }, { id: 'model-b' }],
    defaultModel: 'model-b'
}

describe('claudeSettings', () => {
    it('passes the selected model context window to Claude Code', () => {
        expect(claudeSettings(config, 'model-a').env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1048576')
        expect(claudeSettings(config, 'model-b').env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined()
    })

    it('falls back to the default model window for unknown selections', () => {
        const defaultsToA = { ...config, defaultModel: 'model-a' }
        expect(claudeSettings(defaultsToA, 'default').env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1048576')
    })
})
