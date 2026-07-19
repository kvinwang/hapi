import { describe, expect, it } from 'vitest'
import { isClaudeStopHookFeedback } from './messageClassification'

describe('isClaudeStopHookFeedback', () => {
    it('recognizes Claude Stop hook feedback only at the start', () => {
        expect(isClaudeStopHookFeedback('Stop hook feedback:\nRun tests')).toBe(true)
    })

    it('does not collapse ordinary messages mentioning hooks', () => {
        expect(isClaudeStopHookFeedback('Please update the Stop hook configuration')).toBe(false)
    })

    it('does not collapse messages that quote the marker later', () => {
        expect(isClaudeStopHookFeedback('The stored text was:\nStop hook feedback:\nRun tests')).toBe(false)
        expect(isClaudeStopHookFeedback('<system-reminder>\nStop hook feedback:\nRun tests\n</system-reminder>')).toBe(false)
    })
})
