import { createContext, useEffect, useLayoutEffect } from 'react'

/**
 * Touch layouts scroll the chat with the page itself instead of an inner scroller, so mobile browsers can
 * collapse their toolbars on scroll (they only do that for the document). The workspace sets `doc-scroll` on
 * <html> while this is on; the chain of containers marked `doc-flow` then grows with its content.
 */
export const DocumentScrollContext = createContext(false)

/** Puts the page into document scrolling for as long as a conversation view is using it. */
export function useDocumentScrollRoot(enabled: boolean): void {
    useLayoutEffect(() => {
        if (!enabled) return
        document.documentElement.classList.add('doc-scroll')
        return () => document.documentElement.classList.remove('doc-scroll')
    }, [enabled])
    // iOS Safari keeps the layout viewport when the keyboard opens and only shrinks the visual viewport, so
    // the sticky composer (bottom of the layout viewport) ends up behind the keyboard. Track the visual
    // viewport and let the sticky header/composer follow it (--visual-top / --keyboard-inset).
    useEffect(() => {
        const viewport = window.visualViewport
        if (!enabled || !viewport) return
        const root = document.documentElement
        const update = () => {
            const keyboard = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
            // Only while the keyboard is up: Safari's collapsing toolbar must not push the header down.
            root.style.setProperty('--visual-top', `${keyboard > 0 ? Math.max(0, viewport.offsetTop) : 0}px`)
            root.style.setProperty('--keyboard-inset', `${keyboard}px`)
        }
        const resize = () => {
            // Layout space depends on viewport height, never on its scroll offset.
            root.style.setProperty('--keyboard-space', `${Math.max(0, window.innerHeight - viewport.height)}px`)
            update()
        }
        resize()
        viewport.addEventListener('resize', resize)
        viewport.addEventListener('scroll', update)
        return () => {
            viewport.removeEventListener('resize', resize)
            viewport.removeEventListener('scroll', update)
            root.style.removeProperty('--visual-top')
            root.style.removeProperty('--keyboard-inset')
            root.style.removeProperty('--keyboard-space')
        }
    }, [enabled])
}
