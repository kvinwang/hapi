import { useCallback, useSyncExternalStore } from 'react'

/**
 * Track a CSS media query from React.
 *
 * Use this when a branch should not merely be *hidden* at a breakpoint but skipped entirely —
 * Tailwind's `hidden lg:flex` still mounts the subtree and runs its queries on phones.
 */
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback((onChange: () => void) => {
        if (typeof window === 'undefined' || !window.matchMedia) {
            return () => {}
        }
        const list = window.matchMedia(query)
        list.addEventListener('change', onChange)
        return () => list.removeEventListener('change', onChange)
    }, [query])

    const getSnapshot = useCallback(() => {
        if (typeof window === 'undefined' || !window.matchMedia) {
            return false
        }
        return window.matchMedia(query).matches
    }, [query])

    return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
