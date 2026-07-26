import { describe, expect, it } from 'vitest'
import {
    applyAnchorOffsetScrollTop,
    applyHeightDeltaScrollTop,
    findFirstVisibleMessage,
    findLoadOlderAnchor,
    isWithinChatBottomThreshold,
    shouldAllowAutoLoadOlder,
    shouldFinishScrollSettle,
    shouldStayAtBottomOnLoadOlder
} from './scroll-position'

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

describe('load-older bottom retention', () => {
    it('keeps the live tail when already following or at bottom', () => {
        expect(shouldStayAtBottomOnLoadOlder(true, false)).toBe(true)
        expect(shouldStayAtBottomOnLoadOlder(false, true)).toBe(true)
        expect(shouldStayAtBottomOnLoadOlder(false, false)).toBe(false)
    })
})

describe('auto load-older arming', () => {
    it('stays suppressed until the initial pin settles or the user scrolls up', () => {
        expect(shouldAllowAutoLoadOlder({ initialPinSettled: false, userScrolledUp: false })).toBe(false)
        expect(shouldAllowAutoLoadOlder({ initialPinSettled: true, userScrolledUp: false })).toBe(true)
        expect(shouldAllowAutoLoadOlder({ initialPinSettled: false, userScrolledUp: true })).toBe(true)
    })
})


describe('prepend scroll compensation', () => {
    it('shifts scrollTop by the prepended height delta', () => {
        expect(applyHeightDeltaScrollTop(1_200, 5_000, 7_500)).toBe(3_700)
    })

    it('shifts scrollTop to keep an anchor offset stable', () => {
        expect(applyAnchorOffsetScrollTop(800, 40, 240)).toBe(1_000)
    })
})

describe('load-older settle window', () => {
    it('finishes after stable frames or the max settle budget', () => {
        expect(shouldFinishScrollSettle({ stableHeightFrames: 3, elapsedMs: 20 })).toBe(true)
        expect(shouldFinishScrollSettle({ stableHeightFrames: 1, elapsedMs: 500 })).toBe(true)
        expect(shouldFinishScrollSettle({ stableHeightFrames: 1, elapsedMs: 100 })).toBe(false)
    })
})

describe('load-older anchor choice', () => {
    /** Rows with a controllable top edge; jsdom reports 0 for everything else. */
    function row(top: number): HTMLElement {
        const element = document.createElement('div')
        element.getBoundingClientRect = () => ({ top, bottom: top + 100 }) as DOMRect
        return element
    }

    function container(tops: number[]): HTMLElement {
        const parent = document.createElement('div')
        for (const top of tops) parent.appendChild(row(top))
        return parent
    }

    it('skips the oldest block, which the incoming page merges with', () => {
        // Reader is at the very top: the first visible block is also the seam.
        const parent = container([0, 400, 800])
        expect(findLoadOlderAnchor(parent.children, 0)).toBe(parent.children[1])
    })

    it('keeps the first visible block when it is not the seam', () => {
        const parent = container([-500, 200, 900])
        expect(findLoadOlderAnchor(parent.children, 100)).toBe(parent.children[1])
    })

    it('has nothing to hold when the seam is the only block', () => {
        const parent = container([0])
        expect(findLoadOlderAnchor(parent.children, 0)).toBeNull()
    })
})
