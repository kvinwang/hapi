import { describe, expect, it } from 'vitest'
import { lockDragSelection } from './useDragSelectionGuard'

function prevented(type: string): boolean {
    const event = new Event(type, { bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return event.defaultPrevented
}

describe('drag selection guard', () => {
    it('blocks selection and native menus only while held', () => {
        const release = lockDragSelection()
        expect(document.documentElement.classList.contains('hapi-dragging')).toBe(true)
        expect(prevented('selectstart')).toBe(true)
        expect(prevented('contextmenu')).toBe(true)
        window.dispatchEvent(new Event('pointerup'))
        expect(prevented('selectstart')).toBe(false)
        expect(prevented('contextmenu')).toBe(false)
        expect(document.documentElement.classList.contains('hapi-dragging')).toBe(false)
        release()
    })

    it('supports overlapping handles and releases on cancellation or blur', () => {
        const first = lockDragSelection()
        const second = lockDragSelection()
        first()
        expect(prevented('selectstart')).toBe(true)
        second()
        expect(prevented('selectstart')).toBe(false)
        lockDragSelection()
        window.dispatchEvent(new Event('pointercancel'))
        expect(prevented('selectstart')).toBe(false)
        lockDragSelection()
        window.dispatchEvent(new Event('blur'))
        expect(prevented('selectstart')).toBe(false)
    })
})
