import { describe, expect, it } from 'vitest'
import { resolveClaudeSessionModelMode } from './modelMode'

describe('resolveClaudeSessionModelMode', () => {
    it('returns default when model is missing', () => {
        expect(resolveClaudeSessionModelMode()).toBe('default')
    })

    it('returns default for auto and unsupported models', () => {
        expect(resolveClaudeSessionModelMode('auto')).toBe('default')
        expect(resolveClaudeSessionModelMode('claude-sonnet-4-5')).toBe('default')
    })

    it('returns standard Claude session model modes', () => {
        expect(resolveClaudeSessionModelMode('sonnet')).toBe('sonnet')
        expect(resolveClaudeSessionModelMode('opus')).toBe('opus')
    })

    it('returns 1m Claude session model modes', () => {
        expect(resolveClaudeSessionModelMode('sonnet[1m]')).toBe('sonnet[1m]')
        expect(resolveClaudeSessionModelMode('opus[1m]')).toBe('opus[1m]')
    })
})
