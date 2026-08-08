import { describe, expect, it } from 'vitest'
import {
    COMPACT_VISIBLE_WINDOW_SIZE,
    getVisibleWindowSize,
    VISIBLE_WINDOW_SIZE,
} from './message-window-store'

function setPointer(coarse: boolean) {
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: coarse }),
    })
}

describe('message window size', () => {
    it('keeps the full window for mouse-driven layouts', () => {
        setPointer(false)
        expect(getVisibleWindowSize()).toBe(VISIBLE_WINDOW_SIZE)
    })

    it('bounds the window on touch devices', () => {
        setPointer(true)
        expect(getVisibleWindowSize()).toBe(COMPACT_VISIBLE_WINDOW_SIZE)
    })
})
