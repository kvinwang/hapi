import { useCallback, useEffect, useState } from 'react'

/**
 * One observer per rootMargin, shared by every code block on the page. A chat
 * can mount dozens of blocks at once; a per-block observer is pure overhead.
 */
const observers = new Map<string, IntersectionObserver>()
const callbacks = new WeakMap<Element, () => void>()

function observeNear(node: Element, rootMargin: string, onNear: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
        onNear()
        return () => {}
    }
    let observer = observers.get(rootMargin)
    if (!observer) {
        const created = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                const callback = callbacks.get(entry.target)
                callbacks.delete(entry.target)
                created.unobserve(entry.target)
                callback?.()
            }
        }, { rootMargin })
        observers.set(rootMargin, created)
        observer = created
    }
    callbacks.set(node, onNear)
    observer.observe(node)
    return () => {
        callbacks.delete(node)
        observer?.unobserve(node)
    }
}

/**
 * Latches true once the node comes near the viewport. Mounting every message in
 * a long chat and highlighting all of its code up front costs seconds of main
 * thread; this lets the expensive render wait until the reader is close.
 *
 * Returns a callback ref: chat rows are re-created as content streams in, and a
 * plain ref would leave the observer watching a detached node.
 */
export function useNearViewport<T extends Element>(rootMargin = '600px 0px'): [
    (node: T | null) => void,
    boolean,
] {
    const [node, setNode] = useState<T | null>(null)
    const [near, setNear] = useState(false)

    const setNodeRef = useCallback((next: T | null) => {
        setNode((current) => (current === next ? current : next))
    }, [])

    useEffect(() => {
        if (near || !node) return
        return observeNear(node, rootMargin, () => setNear(true))
    }, [node, near, rootMargin])

    return [setNodeRef, near]
}
