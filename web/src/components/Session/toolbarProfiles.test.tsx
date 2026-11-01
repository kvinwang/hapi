import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { toolbarScreenKey, useToolbarPreferences } from './toolbarProfiles'

function resize(width: number, height: number, screenHeight = height) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
    Object.defineProperty(window.screen, 'height', { configurable: true, value: screenHeight })
    window.dispatchEvent(new Event('resize'))
}

beforeEach(() => { localStorage.clear(); resize(390, 844) })
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('toolbar screen overrides', () => {
    it('inherits the common settings and overrides only fields changed on this screen', () => {
        localStorage.setItem('hapi.toolbarProfiles', JSON.stringify({ defaults: { layout: 'left', expanded: false, position: { x: 50, y: 150 } }, screens: { '390x844': { layout: 'right' } } }))
        const { result } = renderHook(useToolbarPreferences)
        expect(result.current.preferences).toEqual({ layout: 'right', expanded: false, position: { x: 50, y: 150 } })
        act(() => resize(800, 1100))
        expect(result.current.preferences.layout).toBe('left')
    })

    it('remembers folded, unfolded and rotated layouts independently', () => {
        const { result } = renderHook(useToolbarPreferences)
        act(() => result.current.update({ layout: 'left', position: { x: 10, y: 200 }, expanded: false }))
        act(() => resize(800, 1100))
        expect(result.current.preferences.layout).toBe('floating')
        act(() => result.current.update({ layout: 'right', position: { x: 600, y: 400 } }))
        act(() => resize(1100, 800))
        act(() => result.current.update({ layout: 'floating', position: { x: 400, y: 100 } }))
        act(() => resize(390, 844))
        expect(result.current.preferences).toEqual({ layout: 'left', position: { x: 10, y: 200 }, expanded: false })
        act(() => resize(800, 1100))
        expect(result.current.preferences).toMatchObject({ layout: 'right', position: { x: 600, y: 400 } })
        act(() => resize(1100, 800))
        expect(result.current.preferences).toMatchObject({ layout: 'floating', position: { x: 400, y: 100 } })
    })

    it('does not create or overwrite a profile for keyboard or address-bar height changes', () => {
        const { result } = renderHook(useToolbarPreferences)
        act(() => result.current.update({ position: { x: 200, y: 300 } }))
        const stored = localStorage.getItem('hapi.toolbarProfiles')
        act(() => resize(390, 544, 844))
        expect(toolbarScreenKey()).toBe('390x844')
        expect(result.current.preferences.position).toEqual({ x: 200, y: 300 })
        expect(localStorage.getItem('hapi.toolbarProfiles')).toBe(stored)
        act(() => resize(390, 800, 844))
        expect(localStorage.getItem('hapi.toolbarProfiles')).toBe(stored)
    })

    it('uses existing global preferences as common defaults without changing them on screen-specific edits', () => {
        localStorage.setItem('hapi.toolbarLayout', 'right')
        localStorage.setItem('hapi.mobilePosition', JSON.stringify({ x: 200, y: 180 }))
        const { result, unmount } = renderHook(useToolbarPreferences)
        act(() => result.current.update({ layout: 'left' }))
        unmount()
        const next = renderHook(useToolbarPreferences)
        expect(next.result.current.preferences.layout).toBe('left')
        act(() => resize(800, 1100))
        expect(next.result.current.preferences).toMatchObject({ layout: 'right', position: { x: 200, y: 180 } })
    })
})
