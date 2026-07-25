import { describe, expect, it } from 'vitest'
import { findFirstVisibleMessage, isWithinChatBottomThreshold } from './scroll-position'

describe('chat bottom hysteresis', () => {
    it('requires a close approach to enter bottom and tolerates small layout shifts after entry', () => {
        expect(isWithinChatBottomThreshold(17, false)).toBe(false)
        expect(isWithinChatBottomThreshold(16, false)).toBe(true)
        expect(isWithinChatBottomThreshold(63, true)).toBe(true)
        expect(isWithinChatBottomThreshold(65, true)).toBe(false)
    })
})

describe('visible message lookup', () => {
    it('finds the first intersecting child with logarithmic layout reads', () => {
        const container = document.createElement('div')
        const reads = { count: 0 }
        for (let index = 0; index < 512; index += 1) {
            const child = document.createElement('div')
            child.getBoundingClientRect = () => {
                reads.count += 1
                return { bottom: (index + 1) * 20 } as DOMRect
            }
            container.appendChild(child)
        }

        expect(findFirstVisibleMessage(container.children, 4_001)).toBe(container.children[200])
        expect(reads.count).toBeLessThanOrEqual(10)
    })
})
