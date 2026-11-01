import { useDragSelectionGuard } from '@/hooks/useDragSelectionGuard'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorkspaceButtonId } from '@/components/Session/WorkspaceTabBar'

export type PanelItemId = WorkspaceButtonId | 'voice' | 'composer' | 'readback'

/** Two sections; the collapsed panel shows only the first. */
type Layout = [PanelItemId[], PanelItemId[]]

const ALL: PanelItemId[] = ['voice', 'readback', 'sessions', 'composer', 'chat', 'files', 'terminal', 'tree']
const DEFAULT_LAYOUT: Layout = [['voice', 'readback', 'sessions'], ['composer', 'chat', 'files', 'terminal', 'tree']]
const LAYOUT_KEY = 'hapi.panelLayout'
const LONG_PRESS_MS = 400
const MOVE_CANCEL_PX = 8

function loadLayout(): Layout {
    try {
        const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as unknown
        if (Array.isArray(stored) && stored.length === 2 && stored.every(Array.isArray)) {
            const remaining = (stored as unknown[][]).map((section) => section.filter((id) => id !== 'interrupt'))
            const flat = remaining.flat()
            if (new Set(flat).size === flat.length && flat.every((id) => ALL.includes(id as PanelItemId))) {
                const layout = remaining as Layout
                layout[0].push(...ALL.filter((id) => !flat.includes(id)))
                return layout
            }
        }
    } catch {
        // corrupted entry: fall back
    }
    return DEFAULT_LAYOUT
}

type Target = { section: 0 | 1; index: number }

/** Where a drop at (x, y) lands: before or after the slot under the pointer, or at the end of a section. */
function dropTarget(x: number, y: number): Target | null {
    const el = document.elementFromPoint(x, y)
    const slot = el?.closest<HTMLElement>('[data-panel-slot]')
    if (slot) {
        const rect = slot.getBoundingClientRect()
        const index = Number(slot.dataset.index) + (y > rect.top + rect.height / 2 ? 1 : 0)
        return { section: Number(slot.dataset.section) as 0 | 1, index }
    }
    const section = el?.closest<HTMLElement>('[data-panel-section]')
    if (section) return { section: Number(section.dataset.panelSection) as 0 | 1, index: Number.MAX_SAFE_INTEGER }
    return null
}

/**
 * The floating panel's buttons in two sections. A long press picks a button up; dragging it over the panel
 * shows where it will go (either section), and letting go puts it there. The arrangement is remembered.
 */
export function PanelSections(props: { items: Partial<Record<PanelItemId, ReactNode>>; expanded: boolean }) {
    const selection = useDragSelectionGuard()
    const [layout, setLayout] = useState(loadLayout)
    const [dragging, setDraggingState] = useState<{ id: PanelItemId; target: Target | null } | null>(null)
    const draggingRef = useRef(dragging)
    const setDragging = (next: { id: PanelItemId; target: Target | null } | null) => {
        draggingRef.current = next
        setDraggingState(next)
    }
    const pressRef = useRef<{ id: PanelItemId; pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
    const suppressClickRef = useRef(false)

    useEffect(() => {
        if (!dragging) return
        const onMove = (event: PointerEvent) => {
            event.preventDefault()
            const current = draggingRef.current
            if (current) setDragging({ ...current, target: dropTarget(event.clientX, event.clientY) })
        }
        const onUp = () => {
            const drop = draggingRef.current
            setDragging(null)
            if (!drop?.target) return
            const { id, target } = drop
            const next: Layout = [layout[0].filter((item) => item !== id), layout[1].filter((item) => item !== id)]
            // Indexes were taken with the dragged item still in place (and over the shown items only).
            const shown = layout[target.section].filter((item) => props.items[item] != null)
            const from = shown.indexOf(id)
            const shownIndex = from !== -1 && from < target.index ? target.index - 1 : target.index
            const anchor = shown.filter((item) => item !== id)[shownIndex]
            const list = next[target.section]
            list.splice(anchor === undefined ? list.length : list.indexOf(anchor), 0, id)
            localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
            setLayout(next)
        }
        window.addEventListener('pointermove', onMove, { passive: false })
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('pointercancel', onUp)
        }
    }, [dragging !== null, layout, props.items])

    const cancelPress = () => {
        if (pressRef.current) clearTimeout(pressRef.current.timer)
        pressRef.current = null
    }

    // Native listeners on the panel, not React props on each slot: the composer's buttons are portaled into a
    // slot, and React events from a portal bubble through the composer's tree, never reaching the slot.
    const rootRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const root = rootRef.current
        if (!root) return
        const onDown = (event: PointerEvent) => {
            const id = (event.target as Element | null)?.closest<HTMLElement>('[data-panel-item]')?.dataset.panelItem as PanelItemId | undefined
            cancelPress()
            if (!id) return
            selection.begin()
            pressRef.current = {
                id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
                timer: setTimeout(() => {
                    pressRef.current = null
                    suppressClickRef.current = true
                    navigator.vibrate?.(10)
                    setDragging({ id, target: null })
                }, LONG_PRESS_MS)
            }
        }
        const onMove = (event: PointerEvent) => {
            const press = pressRef.current
            if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_CANCEL_PX) cancelPress()
        }
        // The tap that ends a drag is not a click on the button.
        const onClick = (event: MouseEvent) => {
            if (!suppressClickRef.current) return
            suppressClickRef.current = false
            event.preventDefault()
            event.stopPropagation()
        }
        const onContextMenu = (event: Event) => event.preventDefault()
        root.addEventListener('pointerdown', onDown)
        root.addEventListener('pointermove', onMove)
        root.addEventListener('pointerup', cancelPress)
        root.addEventListener('pointercancel', cancelPress)
        root.addEventListener('click', onClick, true)
        root.addEventListener('contextmenu', onContextMenu)
        return () => {
            root.removeEventListener('pointerdown', onDown)
            root.removeEventListener('pointermove', onMove)
            root.removeEventListener('pointerup', cancelPress)
            root.removeEventListener('pointercancel', cancelPress)
            root.removeEventListener('click', onClick, true)
            root.removeEventListener('contextmenu', onContextMenu)
        }
    }, [])

    const slot = (id: PanelItemId, section: 0 | 1, index: number) => {
        const target = dragging?.target
        const lineBefore = target?.section === section && target.index === index
        return (
            <div
                key={id}
                data-panel-slot=""
                data-section={section}
                data-index={index}
                className={`panel-slot relative drag-handle ${dragging?.id === id ? 'scale-110 opacity-60' : ''}`}
                data-panel-item={id}
            >
                {lineBefore ? <span className="absolute -top-1.5 left-0 right-0 h-0.5 rounded-full bg-[var(--app-link)]" /> : null}
                {props.items[id]}
            </div>
        )
    }

    return (
        <div ref={rootRef} className="contents">
            {layout.map((ids, s) => {
                const section = s as 0 | 1
                const shown = ids.filter((id) => props.items[id] != null)
                const lineAtEnd = dragging?.target?.section === section && dragging.target.index >= shown.length
                return (
                    <Fragment key={section}>
                        {section === 1 ? <div className={`h-px w-7 bg-[var(--app-border)] ${props.expanded ? '' : 'hidden'}`} aria-hidden="true" /> : null}
                        {/* The second section stays mounted when collapsed (hidden), so the composer's dock keeps its slot. */}
                        <div
                            data-panel-section={section}
                            className={`relative flex min-h-6 flex-col items-center gap-2 ${section === 1 && !props.expanded ? 'hidden' : ''}`}
                        >
                            {shown.map((id, index) => slot(id, section, index))}
                            {lineAtEnd ? <span className="h-0.5 w-7 rounded-full bg-[var(--app-link)]" /> : null}
                        </div>
                    </Fragment>
                )
            })}
        </div>
    )
}
