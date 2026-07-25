import { describe, expect, it } from 'vitest'
import { isWithinChatBottomThreshold } from './scroll-position'

describe('chat bottom hysteresis', () => {
    it('requires a close approach to enter bottom and tolerates small layout shifts after entry', () => {
        expect(isWithinChatBottomThreshold(17, false)).toBe(false)
        expect(isWithinChatBottomThreshold(16, false)).toBe(true)
        expect(isWithinChatBottomThreshold(63, true)).toBe(true)
        expect(isWithinChatBottomThreshold(65, true)).toBe(false)
    })
})
