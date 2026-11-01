import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { toolbarScreenKey } from '@/components/Session/toolbarProfiles'

type Position = { x: number; y: number }
const key = () => `hapi.voicePanelPosition:${toolbarScreenKey()}`
function read(): Position | null {
    try {
        const value = JSON.parse(localStorage.getItem(key()) ?? 'null')
        return value && Number.isFinite(value.x) && Number.isFinite(value.y) ? value : null
    } catch { return null }
}

export function useVoicePanelPosition(visible: boolean) {
    const ref = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<Position | null>(read)
    const drag = useRef<{ id: number; dx: number; dy: number; initial: Position | null; last: Position } | null>(null)
    const screen = useRef(toolbarScreenKey())
    const clamp = (point: Position): Position => {
        const bounds = ref.current?.getBoundingClientRect()
        const viewport = window.visualViewport
        const left = (viewport?.offsetLeft ?? 0) + 8
        const top = (viewport?.offsetTop ?? 0) + 8
        return {
            x: Math.max(left, Math.min(point.x, left + (viewport?.width ?? window.innerWidth) - (bounds?.width ?? 0) - 16)),
            y: Math.max(top, Math.min(point.y, top + (viewport?.height ?? window.innerHeight) - (bounds?.height ?? 0) - 16))
        }
    }
    useEffect(() => {
        if (!visible) return
        const move = (event: globalThis.PointerEvent) => {
            if (!drag.current || drag.current.id !== event.pointerId) return
            const next = clamp({ x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy })
            drag.current.last = next
            setPosition(next)
        }
        const end = (event: globalThis.PointerEvent) => {
            if (!drag.current || drag.current.id !== event.pointerId) return
            if (event.type === 'pointercancel') setPosition(drag.current.initial)
            else {
                try { localStorage.setItem(key(), JSON.stringify(drag.current.last)) } catch { /* Position still applies in this page. */ }
            }
            drag.current = null
        }
        const resize = () => {
            const nextScreen = toolbarScreenKey()
            if (nextScreen !== screen.current) {
                screen.current = nextScreen
                drag.current = null
                setPosition(read())
            } else setPosition((current) => current ? clamp(current) : null)
        }
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
        if (ref.current) observer?.observe(ref.current)
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
        window.addEventListener('resize', resize)
        window.visualViewport?.addEventListener('resize', resize)
        return () => {
            drag.current = null
            observer?.disconnect()
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
            window.removeEventListener('resize', resize)
            window.visualViewport?.removeEventListener('resize', resize)
        }
    }, [visible])
    const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0 || !ref.current) return
        const bounds = ref.current.getBoundingClientRect()
        drag.current = { id: event.pointerId, dx: event.clientX - bounds.left, dy: event.clientY - bounds.top, initial: position, last: { x: bounds.left, y: bounds.top } }
        event.currentTarget.setPointerCapture(event.pointerId)
        event.preventDefault()
    }
    const style: CSSProperties | undefined = position ? { position: 'fixed', left: position.x, top: position.y } : undefined
    return { ref, style, onPointerDown }
}
