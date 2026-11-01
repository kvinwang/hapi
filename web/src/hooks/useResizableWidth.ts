import { useDragSelectionGuard } from '@/hooks/useDragSelectionGuard'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface ResizableWidthOptions {
    storageKey: string
    min: number
    max: number
    defaultWidth: number
    /** Edge of the element that carries the drag handle. */
    edge: 'left' | 'right'
}

/** Drag-to-resize width, persisted in localStorage. */
export function useResizableWidth(options: ResizableWidthOptions) {
    const { storageKey, min, max, defaultWidth, edge } = options
    const [width, setWidth] = useState(() => {
        try {
            const saved = Number(localStorage.getItem(storageKey))
            if (saved >= min && saved <= max) return saved
        } catch { /* ignore */ }
        return defaultWidth
    })
    const selection = useDragSelectionGuard()
    const isDragging = useRef(false)
    const startX = useRef(0)
    const startWidth = useRef(0)
    const latestWidth = useRef(width)

    const startDrag = useCallback((clientX: number) => {
        selection.begin()
        isDragging.current = true
        startX.current = clientX
        startWidth.current = latestWidth.current
        document.body.style.cursor = 'col-resize'
    }, [selection.begin])

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        startDrag(e.clientX)
    }, [startDrag])

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        if (e.touches.length !== 1) return
        startDrag(e.touches[0].clientX)
    }, [startDrag])

    useEffect(() => {
        const updateWidth = (clientX: number) => {
            const delta = (clientX - startX.current) * (edge === 'right' ? 1 : -1)
            const newWidth = Math.min(max, Math.max(min, startWidth.current + delta))
            latestWidth.current = newWidth
            setWidth(newWidth)
        }

        const stopDrag = () => {
            if (!isDragging.current) return
            isDragging.current = false
            document.body.style.cursor = ''
            selection.end()
            try {
                localStorage.setItem(storageKey, String(latestWidth.current))
            } catch { /* ignore */ }
        }

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return
            updateWidth(e.clientX)
        }

        const handleTouchMove = (e: TouchEvent) => {
            if (!isDragging.current || e.touches.length !== 1) return
            e.preventDefault()
            updateWidth(e.touches[0].clientX)
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', stopDrag)
        window.addEventListener('touchmove', handleTouchMove, { passive: false })
        window.addEventListener('touchend', stopDrag)
        window.addEventListener('touchcancel', stopDrag)
        return () => {
            stopDrag()
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', stopDrag)
            window.removeEventListener('touchmove', handleTouchMove)
            window.removeEventListener('touchend', stopDrag)
            window.removeEventListener('touchcancel', stopDrag)
        }
    }, [storageKey, min, max, edge, selection.end])

    return { width, handleMouseDown, handleTouchStart }
}
