import { useCallback, useEffect, useRef } from 'react'

let locks = 0
const prevent = (event: Event) => event.preventDefault()

export function lockDragSelection(): () => void {
    if (locks++ === 0) {
        document.documentElement.classList.add('hapi-dragging')
        document.addEventListener('selectstart', prevent, true)
        document.addEventListener('contextmenu', prevent, true)
    }
    window.getSelection()?.removeAllRanges()
    let released = false
    const release = () => {
        if (released) return
        released = true
        for (const event of ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel', 'dragend', 'blur']) window.removeEventListener(event, release, true)
        if (--locks === 0) {
            document.documentElement.classList.remove('hapi-dragging')
            document.removeEventListener('selectstart', prevent, true)
            document.removeEventListener('contextmenu', prevent, true)
        }
    }
    for (const event of ['pointerup', 'pointercancel', 'mouseup', 'touchend', 'touchcancel', 'dragend', 'blur']) window.addEventListener(event, release, true)
    return release
}

export function useDragSelectionGuard() {
    const release = useRef<(() => void) | null>(null)
    const begin = useCallback(() => { release.current?.(); release.current = lockDragSelection() }, [])
    const end = useCallback(() => { release.current?.(); release.current = null }, [])
    useEffect(() => end, [end])
    return { begin, end }
}
