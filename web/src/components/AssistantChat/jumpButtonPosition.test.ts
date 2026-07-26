import { describe, expect, it, beforeEach } from 'vitest'
import {
    JUMP_BUTTON_MARGIN,
    loadJumpButtonPosition,
    offsetToPosition,
    positionToOffset,
    saveJumpButtonPosition
} from './jumpButtonPosition'

const container = { width: 400, height: 800 }
const button = { width: 36, height: 36 }

describe('jump button position', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('places a remembered fraction back where it was dropped', () => {
        const dropped = offsetToPosition({ left: 300, top: 600 }, container, button)
        expect(positionToOffset(dropped, container, button)).toEqual({ left: 300, top: 600 })
    })

    it('scales across a viewport that changed shape', () => {
        const dropped = offsetToPosition({ left: 182, top: 382 }, container, button)
        // Same session, phone turned sideways: still centred, still fully inside.
        const landscape = positionToOffset(dropped, { width: 800, height: 360 }, button)
        expect(landscape.left).toBeCloseTo(382, 0)
        expect(landscape.top).toBeCloseTo(162, 0)
    })

    it('pulls a stale position back inside the chat area', () => {
        const offscreen = positionToOffset({ xRatio: 1, yRatio: 1 }, container, button)
        expect(offscreen).toEqual({
            left: container.width - button.width - JUMP_BUTTON_MARGIN,
            top: container.height - button.height - JUMP_BUTTON_MARGIN
        })
    })

    it('survives a round trip through storage and ignores junk', () => {
        saveJumpButtonPosition({ xRatio: 0.25, yRatio: 0.75 })
        expect(loadJumpButtonPosition()).toEqual({ xRatio: 0.25, yRatio: 0.75 })

        localStorage.setItem('hapi-jump-latest-position', 'not json')
        expect(loadJumpButtonPosition()).toBeNull()
    })
})
