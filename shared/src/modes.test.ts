import { describe, expect, it } from 'vitest'
import { normalizeDetectedClaudeModelMode } from './modes'

describe('normalizeDetectedClaudeModelMode', () => {
    it('uses the rolling Fable alias for version-pinned detected ids', () => {
        expect(normalizeDetectedClaudeModelMode('claude-fable-5')).toBe('fable')
        expect(normalizeDetectedClaudeModelMode('claude-fable-5[1m]')).toBe('fable[1m]')
        expect(normalizeDetectedClaudeModelMode('claude-fable-5.1[1m]')).toBe('fable[1m]')
    })

    it('preserves other detected model values', () => {
        expect(normalizeDetectedClaudeModelMode('opus[1m]')).toBe('opus[1m]')
        expect(normalizeDetectedClaudeModelMode('claude-opus-4-6')).toBe('claude-opus-4-6')
    })
})
