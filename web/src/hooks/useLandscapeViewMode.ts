import { useEffect, useRef } from 'react'

/**
 * A phone turned sideways is being used to read, not to type: the composer and
 * the header eat most of a short viewport. Turning back to portrait undoes it,
 * but only when this hook was the one that turned it on — a reader who left
 * view mode by hand stays out of it.
 */
export function useLandscapeViewMode(
    enabled: boolean,
    setViewMode: (next: boolean) => void
): void {
    const autoEnteredRef = useRef(false)

    useEffect(() => {
        if (!enabled || typeof window === 'undefined' || !window.matchMedia) {
            return
        }
        // Tablets and desktops have room for both; this is about handsets.
        const coarse = window.matchMedia('(pointer: coarse)')
        const landscape = window.matchMedia('(orientation: landscape)')
        const shortSide = window.matchMedia('(max-height: 500px)')

        const apply = () => {
            if (!coarse.matches) return
            if (landscape.matches && shortSide.matches) {
                if (autoEnteredRef.current) return
                autoEnteredRef.current = true
                setViewMode(true)
                return
            }
            if (autoEnteredRef.current) {
                autoEnteredRef.current = false
                setViewMode(false)
            }
        }

        apply()
        landscape.addEventListener('change', apply)
        shortSide.addEventListener('change', apply)
        return () => {
            landscape.removeEventListener('change', apply)
            shortSide.removeEventListener('change', apply)
        }
    }, [enabled, setViewMode])
}
