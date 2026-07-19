import { describe, expect, it } from 'vitest'
import { isClaudeStopHookFeedback } from './messageClassification'

describe('isClaudeStopHookFeedback', () => {
    it('recognizes wrapped Claude Stop hook feedback', () => {
        expect(isClaudeStopHookFeedback('<system-reminder>\nStop hook feedback:\nRun tests\n</system-reminder>')).toBe(true)
    })

    it('does not collapse ordinary messages mentioning hooks', () => {
        expect(isClaudeStopHookFeedback('Please update the Stop hook configuration')).toBe(false)
    })
})
