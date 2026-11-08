import { useEffect, type ReactNode } from 'react'
import type { useConversationWorkspace } from '@/hooks/useConversationWorkspace'

/** One responsive list/detail shell for both session and thread conversations. */
export function ConversationWorkspace({
    layout: baseLayout,
    selection,
    sidebar,
    children,
    overlays,
    listLabel,
    contentLabel,
    closeLabel
}: {
    layout: ReturnType<typeof useConversationWorkspace>
    selection?: { sidebar: ReactNode; onCancel: () => void; label: string }
    sidebar: ReactNode
    children: ReactNode
    overlays?: ReactNode
    listLabel: string
    contentLabel: string
    closeLabel: string
}) {
    const layout = selection ? {
        ...baseLayout, showList: true, drawer: !baseLayout.persistent && !baseLayout.isIndex,
        closeDrawer: () => { selection.onCancel(); baseLayout.closeDrawer() },
        hideSidebar: () => { selection.onCancel(); baseLayout.hideSidebar() }
    } : baseLayout
    useEffect(() => {
        if (!selection) return
        const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') selection.onCancel() }
        window.addEventListener('keydown', cancel)
        return () => window.removeEventListener('keydown', cancel)
    }, [selection?.onCancel])
    return (
        <div className="doc-flow relative flex h-full min-h-0 min-w-0">
            {layout.drawer && (
                <button
                    type="button"
                    aria-label={closeLabel}
                    className="hapi-drawer-overlay fixed inset-0 z-40 bg-black/50"
                    data-state="open"
                    onClick={layout.closeDrawer}
                />
            )}
            <aside
                hidden={!layout.showList}
                aria-label={selection?.label ?? listLabel}
                className={`${layout.showList ? 'flex' : 'hidden'} min-h-0 shrink-0 flex-col bg-[var(--app-bg)] ${layout.drawer ? 'hapi-session-drawer fixed inset-y-0 left-0 z-50 w-[85vw] max-w-sm shadow-2xl' : ''}`}
                data-state={layout.drawer ? 'open' : undefined}
                style={layout.drawer ? undefined : { width: layout.persistent ? layout.width : '100%' }}
            >
                {selection?.sidebar ?? sidebar}
            </aside>
            {layout.persistent && layout.showList && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize conversation list"
                    className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center hover:bg-[var(--app-link)]"
                    onMouseDown={layout.handleMouseDown}
                    onTouchStart={layout.handleTouchStart}
                >
                    <div className="absolute inset-y-0 -left-2 -right-2" />
                    <div className="h-full w-px bg-[var(--app-divider)] group-hover:bg-transparent" />
                    {!layout.isIndex && (
                        <button
                            type="button"
                            aria-label={closeLabel}
                            title={closeLabel}
                            onMouseDown={event => event.stopPropagation()}
                            onClick={layout.hideSidebar}
                            className="absolute z-10 flex h-10 w-5 items-center justify-center rounded-r-md border border-l-0 border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-sm hover:text-[var(--app-fg)]"
                        >
                            <span aria-hidden="true">‹</span>
                        </button>
                    )}
                </div>
            )}
            <section
                hidden={!layout.showContent}
                aria-label={contentLabel}
                className={`${layout.showContent ? 'flex' : 'hidden'} doc-flow min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}
            >
                <div className="doc-flow min-h-0 flex-1">{children}</div>
            </section>
            {overlays}
        </div>
    )
}
