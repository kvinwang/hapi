import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useDragSelectionGuard } from '@/hooks/useDragSelectionGuard'
import { useTranslation } from '@/lib/use-translation'
import { PanelSections, type PanelItemId } from './PanelSections'
import { useToolbarPreferences } from './toolbarProfiles'
import { toolbarDropLayout } from './toolbarLayout'

export function WorkspaceTools({
    items,
    children
}: {
    items: Partial<Record<PanelItemId, ReactNode>>
    children: ReactNode
}) {
    const { preferences: toolbarPreferences, screenKey, update: updateToolbar } = useToolbarPreferences()
    const mobileTabsVisible = toolbarPreferences.expanded
    const { t } = useTranslation()
    const selection = useDragSelectionGuard()
    const savedToolbarLayout = toolbarPreferences.layout
    const [toolbarDragging, setToolbarDragging] = useState(false)
    const [dockPreview, setDockPreview] = useState<{
        side: 'left' | 'right'
        left: number
        top: number
        height: number
    } | null>(null)
    const toolbarLayout = toolbarDragging ? 'floating' : savedToolbarLayout
    const workspaceRef = useRef<HTMLDivElement | null>(null)
    const mobileAnchorRef = useRef<HTMLElement | null>(null)
    const dragStateRef = useRef<{
        pointerId: number
        dx: number
        dy: number
        width: number
        height: number
        x: number
        y: number
        moved: boolean
        originalPosition: { x: number; y: number }
    } | null>(null)
    const [mobilePosition, setMobilePosition] = useState(toolbarPreferences.position)
    useEffect(() => {
        dragStateRef.current = null
        setToolbarDragging(false)
        setDockPreview(null)
        setMobilePosition(toolbarPreferences.position)
    }, [screenKey, toolbarPreferences.position])

    const clampMobilePosition = useCallback((x: number, y: number, width: number, height: number) => {
        const pad = 8
        const maxX = Math.max(pad, window.innerWidth - width - pad)
        const maxY = Math.max(pad, window.innerHeight - height - pad)
        return {
            x: Math.min(Math.max(pad, x), maxX),
            y: Math.min(Math.max(pad, y), maxY)
        }
    }, [])

    const getDockPreview = useCallback((x: number, y: number) => {
        const rect = workspaceRef.current?.getBoundingClientRect()
        const viewport = window.visualViewport
        const top = Math.max(viewport?.offsetTop ?? 0, rect?.top ?? 0)
        const left = rect?.left ?? 0
        const right = rect?.right ?? window.innerWidth
        const side = toolbarDropLayout(x, y, left, right, top)
        if (side === 'floating') return null
        return {
            side,
            left: side === 'left' ? left : right - 48,
            top,
            height: Math.max(0, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - top)
        }
    }, [])

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            const drag = dragStateRef.current
            if (!drag || drag.pointerId !== event.pointerId) {
                return
            }
            if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) {
                return
            }
            drag.moved = true
            setToolbarDragging(true)
            setDockPreview(getDockPreview(event.clientX, event.clientY))
            const next = clampMobilePosition(event.clientX - drag.dx, event.clientY - drag.dy, drag.width, drag.height)
            setMobilePosition(next)
        }
        const onPointerUp = (event: PointerEvent) => {
            const drag = dragStateRef.current
            if (!drag || drag.pointerId !== event.pointerId) {
                return
            }
            dragStateRef.current = null
            if (event.type === 'pointercancel') {
                setMobilePosition(drag.originalPosition)
            } else if (drag.moved) {
                updateToolbar({
                    layout: getDockPreview(event.clientX, event.clientY)?.side ?? 'floating',
                    position: clampMobilePosition(
                        event.clientX - drag.dx,
                        event.clientY - drag.dy,
                        drag.width,
                        drag.height
                    )
                })
            }
            setToolbarDragging(false)
            setDockPreview(null)
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
        return () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
        }
    }, [clampMobilePosition, getDockPreview, updateToolbar])

    useEffect(() => {
        const onResize = () => {
            const el = mobileAnchorRef.current
            if (!el || savedToolbarLayout !== 'floating') {
                return
            }
            const rect = el.getBoundingClientRect()
            setMobilePosition(
                clampMobilePosition(
                    toolbarPreferences.position.x,
                    toolbarPreferences.position.y,
                    rect.width,
                    rect.height
                )
            )
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [clampMobilePosition, savedToolbarLayout, toolbarPreferences.position])

    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            const el = mobileAnchorRef.current
            if (!el || savedToolbarLayout !== 'floating') {
                return
            }
            const rect = el.getBoundingClientRect()
            setMobilePosition(
                clampMobilePosition(
                    toolbarPreferences.position.x,
                    toolbarPreferences.position.y,
                    rect.width,
                    rect.height
                )
            )
        })
        return () => window.cancelAnimationFrame(frame)
    }, [mobileTabsVisible, clampMobilePosition, savedToolbarLayout, screenKey, toolbarPreferences.position])

    const startDrag = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (event.button !== 0) return
            const el = mobileAnchorRef.current
            if (!el) {
                return
            }
            selection.begin()
            const rect = el.getBoundingClientRect()
            dragStateRef.current = {
                pointerId: event.pointerId,
                dx: event.clientX - rect.left,
                dy: event.clientY - rect.top,
                width: rect.width,
                height: Math.min(
                    rect.height,
                    (el.lastElementChild?.getBoundingClientRect().bottom ?? rect.bottom) - rect.top + 8
                ),
                x: event.clientX,
                y: event.clientY,
                moved: false,
                originalPosition: mobilePosition
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
        },
        [mobilePosition, selection.begin]
    )

    return (
        <div
            ref={workspaceRef}
            className="doc-flow relative flex h-full min-h-0"
            style={
                {
                    '--workspace-toolbar-left': toolbarLayout === 'left' ? '3rem' : '0px',
                    '--workspace-toolbar-right': toolbarLayout === 'right' ? '3rem' : '0px'
                } as React.CSSProperties
            }
        >
            {dockPreview ? (
                <div
                    data-toolbar-dock-preview={dockPreview.side}
                    role="status"
                    className="pointer-events-none fixed z-30 w-12 rounded-md border-2 border-dashed border-[var(--app-link)] bg-[var(--app-link)]/15"
                    style={{ left: dockPreview.left, top: dockPreview.top, height: dockPreview.height }}
                >
                    <span
                        className={`absolute top-2 whitespace-nowrap rounded-md bg-[var(--app-bg)] px-3 py-2 text-xs text-[var(--app-fg)] shadow-md ${dockPreview.side === 'left' ? 'left-full ml-2' : 'right-full mr-2'}`}
                    >
                        {t(`toolbar.dockPreview.${dockPreview.side}`)}
                    </span>
                </div>
            ) : null}
            <div
                ref={el => {
                    mobileAnchorRef.current = el
                }}
                data-toolbar-layout={toolbarLayout}
                className={`z-40 flex select-none flex-col items-center gap-2 border-[var(--app-border)] bg-[var(--app-bg)] p-1 ${
                    toolbarLayout === 'floating'
                        ? 'fixed rounded-xl border shadow-lg'
                        : `sticky top-0 h-dvh w-12 shrink-0 self-start overflow-y-auto ${toolbarLayout === 'right' ? 'order-last border-l' : 'border-r'}`
                }`}
                style={toolbarLayout === 'floating' ? { left: mobilePosition.x, top: mobilePosition.y } : undefined}
            >
                <button
                    type="button"
                    onPointerDown={startDrag}
                    className="flex h-4 w-9 items-center justify-center rounded-md text-[var(--app-hint)] active:bg-[var(--app-subtle-bg)] drag-handle"
                    aria-label="Drag tabs"
                    title="Drag"
                >
                    <span className="h-0.5 w-4 rounded-full bg-current opacity-70" />
                </button>
                <PanelSections expanded={mobileTabsVisible} items={items} />
                <button
                    type="button"
                    onClick={() => updateToolbar({ expanded: !mobileTabsVisible })}
                    className="flex h-7 w-9 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                    title={mobileTabsVisible ? 'Collapse' : 'Expand'}
                    aria-label={mobileTabsVisible ? 'Collapse tabs' : 'Expand tabs'}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <polyline points={mobileTabsVisible ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                    </svg>
                </button>
            </div>
            {children}
        </div>
    )
}
