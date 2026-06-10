import { describe, expect, it } from 'vitest'
import { resolveClaudeSessionModelMode } from './modelMode'

describe('resolveClaudeSessionModelMode', () => {
    it('returns default when model is missing', () => {
        expect(resolveClaudeSessionModelMode()).toBe('default')
    })

    it('returns default for auto and empty values', () => {
        expect(resolveClaudeSessionModelMode('auto')).toBe('default')
        expect(resolveClaudeSessionModelMode('default')).toBe('default')
        expect(resolveClaudeSessionModelMode('  ')).toBe('default')
    })

    it('passes through arbitrary model ids for dynamic model support', () => {
        expect(resolveClaudeSessionModelMode('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
        expect(resolveClaudeSessionModelMode('claude-fable-5[1m]')).toBe('claude-fable-5[1m]')
    })

    it('returns standard Claude session model modes', () => {
        expect(resolveClaudeSessionModelMode('sonnet')).toBe('sonnet')
        expect(resolveClaudeSessionModelMode('opus')).toBe('opus')
    })

    it('returns 1m Claude session model modes', () => {
        expect(resolveClaudeSessionModelMode('sonnet[1m]')).toBe('sonnet[1m]')
        expect(resolveClaudeSessionModelMode('opus[1m]')).toBe('opus[1m]')
    })

    it('returns fable Claude session model modes', () => {
        expect(resolveClaudeSessionModelMode('fable')).toBe('fable')
        expect(resolveClaudeSessionModelMode('fable[1m]')).toBe('fable[1m]')
    })
})
