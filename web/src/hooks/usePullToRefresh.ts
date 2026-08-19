import { useCallback, useEffect, useRef, useState } from 'react'

export type PullToRefreshPhase = 'idle' | 'pulling' | 'ready' | 'refreshing' | 'done'

export type PullToRefreshState = {
    /** Current phase of the gesture / refresh lifecycle. */
    phase: PullToRefreshPhase
    /** Vertical offset (px) the content should be pushed down by. */
    distance: number
    /** Distance (px) at which releasing triggers a refresh. */
    threshold: number
    /** `distance / threshold` clamped to 0..1. */
    progress: number
    /** True while the offset should animate (release / settle) instead of tracking the finger. */
    animating: boolean
}

type UsePullToRefreshOptions = {
    /** Called when the gesture (or `refresh()`) triggers a reload. May return a promise. */
    onRefresh: () => unknown | Promise<unknown>
    /** Disable the gesture entirely (defaults to enabled). */
    enabled?: boolean
    /** Pull distance required to arm a refresh. */
    threshold?: number
    /** Hard cap on how far the content can be dragged. */
    maxDistance?: number
}

/** Finger travel ignored before the pull starts, so taps/scrolls are not hijacked. */
const START_SLOP_PX = 8
/** Rubber-band factor: the content moves slower than the finger. */
const RESISTANCE = 0.55
const DEFAULT_THRESHOLD_PX = 56
const DEFAULT_MAX_DISTANCE_PX = 96
/** Keep the spinner visible long enough to read even when the refetch is instant. */
const MIN_REFRESHING_MS = 400
/** How long the "updated" confirmation stays on screen. */
const DONE_VISIBLE_MS = 600

/**
 * Pull-to-refresh for a scrollable container.
 *
 * Native pull-to-refresh is disabled app-wide (`overscroll-behavior: none`), so this implements
 * the gesture manually: attach `containerRef` to the scroll container and render an indicator
 * sized by `state.distance` as its first child.
 */
export function usePullToRefresh<T extends HTMLElement = HTMLDivElement>({
    onRefresh,
    enabled = true,
    threshold = DEFAULT_THRESHOLD_PX,
    maxDistance = DEFAULT_MAX_DISTANCE_PX,
}: UsePullToRefreshOptions): {
    containerRef: React.RefObject<T | null>
    state: PullToRefreshState
    /** Trigger a refresh programmatically (e.g. from a toolbar button) with the same indicator. */
    refresh: () => void
} {
    const containerRef = useRef<T | null>(null)
    const [phase, setPhase] = useState<PullToRefreshPhase>('idle')
    const [distance, setDistance] = useState(0)
    const [animating, setAnimating] = useState(false)

    const phaseRef = useRef<PullToRefreshPhase>('idle')
    const onRefreshRef = useRef(onRefresh)
    const mountedRef = useRef(true)
    const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

    useEffect(() => {
        onRefreshRef.current = onRefresh
    }, [onRefresh])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            for (const timer of timersRef.current) clearTimeout(timer)
            timersRef.current = []
        }
    }, [])

    const applyPhase = useCallback((next: PullToRefreshPhase) => {
        phaseRef.current = next
        setPhase(next)
    }, [])

    const later = useCallback((fn: () => void, ms: number) => {
        const timer = setTimeout(() => {
            timersRef.current = timersRef.current.filter(t => t !== timer)
            if (mountedRef.current) fn()
        }, ms)
        timersRef.current.push(timer)
    }, [])

    const runRefresh = useCallback(() => {
        if (phaseRef.current === 'refreshing') return
        applyPhase('refreshing')
        setAnimating(true)
        setDistance(threshold)

        const startedAt = performance.now()
        const settle = () => {
            const elapsed = performance.now() - startedAt
            later(() => {
                applyPhase('done')
                later(() => {
                    applyPhase('idle')
                    setAnimating(true)
                    setDistance(0)
                }, DONE_VISIBLE_MS)
            }, Math.max(0, MIN_REFRESHING_MS - elapsed))
        }

        try {
            void Promise.resolve(onRefreshRef.current()).then(settle, settle)
        } catch {
            settle()
        }
    }, [applyPhase, later, threshold])

    useEffect(() => {
        const el = containerRef.current
        if (!el || !enabled) return

        let startY = 0
        let startX = 0
        /** A touch started at the top of the scroller and may still become a pull. */
        let candidate = false
        /** The pull gesture has been claimed (scrolling is suppressed). */
        let active = false
        let current = 0

        const abort = () => {
            candidate = false
            if (active) {
                active = false
                current = 0
                setAnimating(true)
                setDistance(0)
                applyPhase('idle')
            }
        }

        const handleTouchStart = (event: TouchEvent) => {
            if (phaseRef.current === 'refreshing') return
            if (event.touches.length !== 1 || el.scrollTop > 0) {
                candidate = false
                return
            }
            startY = event.touches[0].clientY
            startX = event.touches[0].clientX
            candidate = true
            active = false
            current = 0
        }

        const handleTouchMove = (event: TouchEvent) => {
            if (!candidate || phaseRef.current === 'refreshing') return
            if (event.touches.length !== 1) {
                abort()
                return
            }
            const dy = event.touches[0].clientY - startY
            const dx = event.touches[0].clientX - startX

            if (!active) {
                // Give up as soon as the gesture looks like a scroll-up or a horizontal swipe.
                if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
                    candidate = false
                    return
                }
                if (dy < START_SLOP_PX) return
                if (el.scrollTop > 0) {
                    candidate = false
                    return
                }
                active = true
                setAnimating(false)
            }

            if (dy <= 0) {
                abort()
                return
            }

            current = Math.min(maxDistance, (dy - START_SLOP_PX) * RESISTANCE)
            setDistance(current)
            applyPhase(current >= threshold ? 'ready' : 'pulling')
            if (event.cancelable) event.preventDefault()
        }

        const handleTouchEnd = () => {
            if (!active) {
                candidate = false
                return
            }
            const reached = current >= threshold
            candidate = false
            active = false
            current = 0
            setAnimating(true)
            if (reached) {
                runRefresh()
            } else {
                setDistance(0)
                applyPhase('idle')
            }
        }

        el.addEventListener('touchstart', handleTouchStart, { passive: true })
        el.addEventListener('touchmove', handleTouchMove, { passive: false })
        el.addEventListener('touchend', handleTouchEnd)
        el.addEventListener('touchcancel', abort)
        return () => {
            el.removeEventListener('touchstart', handleTouchStart)
            el.removeEventListener('touchmove', handleTouchMove)
            el.removeEventListener('touchend', handleTouchEnd)
            el.removeEventListener('touchcancel', abort)
        }
    }, [applyPhase, enabled, maxDistance, runRefresh, threshold])

    return {
        containerRef,
        state: {
            phase,
            distance,
            threshold,
            progress: Math.max(0, Math.min(1, distance / threshold)),
            animating,
        },
        refresh: runRefresh,
    }
}
