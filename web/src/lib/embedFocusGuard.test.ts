import { describe, expect, it, vi } from 'vitest'
import { installEmbedFocusGuard } from './embedFocusGuard'

describe('embedFocusGuard', () => {
    installEmbedFocusGuard()

    function composer(): HTMLTextAreaElement {
        const ta = document.createElement('textarea')
        ta.setAttribute('data-hapi-composer', '')
        document.body.appendChild(ta)
        return ta
    }

    it('blocks programmatic focus without a tap', () => {
        const ta = composer()
        ta.focus()
        expect(document.activeElement).not.toBe(ta)
        ta.remove()
    })

    it('allows focus right after a tap on the composer, and not long after', () => {
        vi.useFakeTimers()
        const ta = composer()
        ta.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        ta.focus()
        expect(document.activeElement).toBe(ta)
        ta.blur()
        vi.advanceTimersByTime(2000)
        ta.focus()
        expect(document.activeElement).not.toBe(ta)
        ta.remove()
        vi.useRealTimers()
    })

    it('a tap elsewhere does not allow focusing the composer', () => {
        const ta = composer()
        const btn = document.createElement('button')
        document.body.appendChild(btn)
        btn.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        ta.focus()
        expect(document.activeElement).not.toBe(ta)
        ta.remove()
        btn.remove()
    })

    it('leaves other elements alone', () => {
        const other = document.createElement('textarea')
        document.body.appendChild(other)
        other.focus()
        expect(document.activeElement).toBe(other)
        other.remove()
    })
})
