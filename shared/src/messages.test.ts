import { describe, expect, it } from 'vitest'
import { isClaudeChatVisibleMessage } from './messages'

describe('isClaudeChatVisibleMessage', () => {
    it('allows chat content and selected system events', () => {
        expect(isClaudeChatVisibleMessage({ type: 'assistant' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'user' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'summary' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'api_error' })).toBe(true)
    })

    it('rejects internal and unknown Claude envelopes', () => {
        expect(isClaudeChatVisibleMessage({ type: 'output' })).toBe(false)
        expect(isClaudeChatVisibleMessage({ type: 'result' })).toBe(true)
        expect(isClaudeChatVisibleMessage({ type: 'system', subtype: 'init' })).toBe(false)
    })
})
