import { describe, expect, it } from 'vitest'
import { toolbarDropLayout } from './toolbarLayout'

describe('toolbar docking zones', () => {
    it('only docks in the top corners', () => {
        expect(toolbarDropLayout(10, 40, 0, 390, 0)).toBe('left')
        expect(toolbarDropLayout(380, 40, 0, 390, 0)).toBe('right')
        expect(toolbarDropLayout(195, 40, 0, 390, 0)).toBe('floating')
        expect(toolbarDropLayout(10, 300, 0, 390, 0)).toBe('floating')
        expect(toolbarDropLayout(380, 300, 0, 390, 0)).toBe('floating')
    })

    it('uses the workspace edge and visible top when sidebars or viewport offsets are present', () => {
        expect(toolbarDropLayout(350, 80, 340, 1280, 50)).toBe('left')
        expect(toolbarDropLayout(1270, 80, 340, 1280, 50)).toBe('right')
        expect(toolbarDropLayout(350, 147, 340, 1280, 50)).toBe('floating')
    })
})
