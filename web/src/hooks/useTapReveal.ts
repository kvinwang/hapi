import { useCallback, useState, type MouseEvent } from 'react'

/**
 * Touch devices hide per-message chrome (meta line, fork/usage buttons) behind the `touch:` variant;
 * a tap on the message toggles `data-revealed`, which `touch:group-data-[revealed]/msg:*` shows again.
 * Taps on controls/links and text selections are ignored.
 */
export function useTapReveal() {
    const [revealed, setRevealed] = useState(false)
    const onClick = useCallback((event: MouseEvent<HTMLElement>) => {
        if (event.target instanceof Element && event.target.closest('a, button, input, textarea, select, summary, [role="button"]')) return
        if (window.getSelection()?.toString()) return
        setRevealed((value) => !value)
    }, [])
    return { 'data-revealed': revealed || undefined, onClick }
}
