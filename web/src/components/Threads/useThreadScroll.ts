import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DocumentScrollContext, useDocumentScrollRoot } from '@/components/Session/documentScroll'

/** Keeps a thread pinned to its latest message, whether the page or the viewport element is what scrolls. */
export function useThreadScroll(content: unknown, loadingOlder: boolean) {
    const documentScroll = useContext(DocumentScrollContext)
    useDocumentScrollRoot(documentScroll)
    const viewport = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const prepend = useRef<{ height: number; top: number } | null>(null)
    const [atBottom, setAtBottom] = useState(true)
    const scroller = useCallback(
        () => (documentScroll ? document.scrollingElement as HTMLElement | null : viewport.current),
        [documentScroll]
    )
    const jumpToLatest = useCallback(() => {
        const el = scroller()
        if (el) el.scrollTop = el.scrollHeight
        stick.current = true
        setAtBottom(true)
    }, [scroller])
    /** Call before loading older messages, so the ones on screen stay where they are. */
    const keepPositionOnPrepend = useCallback(() => {
        const el = scroller()
        if (!el) return
        prepend.current = { height: el.scrollHeight, top: el.scrollTop }
        stick.current = false
    }, [scroller])
    /** Runs `listener` on scroll with the area of the screen the conversation is visible in. */
    const onScroll = useCallback((listener: () => void) => {
        const target = documentScroll ? window : viewport.current
        target?.addEventListener('scroll', listener, { passive: true })
        return () => target?.removeEventListener('scroll', listener)
    }, [documentScroll])
    const visibleArea = useCallback(() => (
        documentScroll || !viewport.current
            ? { top: 0, bottom: window.innerHeight }
            : viewport.current.getBoundingClientRect()
    ), [documentScroll])

    useLayoutEffect(() => {
        const el = scroller()
        if (!el) return
        if (prepend.current && !loadingOlder) {
            el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height
            prepend.current = null
        } else if (stick.current) {
            el.scrollTop = el.scrollHeight
        }
    }, [content, loadingOlder, scroller])
    useEffect(() => onScroll(() => {
        const el = scroller()
        if (!el) return
        const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        stick.current = near
        setAtBottom(near)
    }), [onScroll, scroller])
    // Late layout (images, code blocks, the composer opening) must not unpin the conversation.
    useEffect(() => {
        const el = viewport.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(() => {
            if (stick.current) {
                const target = scroller()
                if (target) target.scrollTop = target.scrollHeight
            }
        })
        if (el.firstElementChild) observer.observe(el.firstElementChild)
        const chat = el.closest('.conversation-chat')
        if (chat) observer.observe(chat)
        return () => observer.disconnect()
    }, [scroller])

    return { viewport, documentScroll, atBottom, jumpToLatest, keepPositionOnPrepend, onScroll, visibleArea }
}
