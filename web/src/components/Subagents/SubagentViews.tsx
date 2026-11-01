import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { SubagentEntry, SubagentStatus } from '@hapi/protocol/types'
import { cn, formatElapsedDuration } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { useResizableWidth } from '@/hooks/useResizableWidth'
import { isSubagentRunning } from './context'

const STATUS_CLASS: Record<SubagentStatus, string> = {
    running: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
    stopped: 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]'
}

function displayStatus(entry: SubagentEntry, ownerActive: boolean): SubagentStatus {
    return entry.status === 'running' && !ownerActive ? 'stopped' : entry.status
}

function formatTokens(tokens: number): string {
    return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function StatusBadge(props: { status: SubagentStatus }) {
    const { t } = useTranslation()
    return (
        <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', STATUS_CLASS[props.status])}>
            {props.status === 'running' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
            {t(`subagent.status.${props.status}`)}
        </span>
    )
}

function SubagentStats(props: { entry: SubagentEntry }) {
    const { t } = useTranslation()
    const { entry } = props
    return (
        <>
            {entry.agentType ? <span>{entry.agentType}</span> : null}
            {entry.toolUses !== undefined ? <span>{t('subagent.toolUses', { count: entry.toolUses })}</span> : null}
            {entry.totalTokens !== undefined ? <span>{t('subagent.tokens', { count: formatTokens(entry.totalTokens) })}</span> : null}
            {entry.durationMs !== undefined ? <span>{formatElapsedDuration(entry.durationMs / 1000)}</span> : null}
        </>
    )
}

/** Body of a subagent tool card: live status while running, the report summary once done. */
export function SubagentSummary(props: { entry: SubagentEntry; ownerActive: boolean; onOpen: (sessionId: string) => void }) {
    const { t } = useTranslation()
    const { entry } = props
    const running = isSubagentRunning(entry, props.ownerActive)
    const sessionId = entry.sessionId
    return (
        <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--app-hint)]">
                <StatusBadge status={displayStatus(entry, props.ownerActive)} />
                <SubagentStats entry={entry} />
                {sessionId ? (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation()
                            props.onOpen(sessionId)
                        }}
                        className="ml-auto rounded-md border border-[var(--app-border)] px-2 py-0.5 text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                    >
                        {t('subagent.open')} →
                    </button>
                ) : null}
            </div>
            {running && entry.activity ? (
                <div className="truncate font-mono text-[var(--app-hint)]">{entry.activity}</div>
            ) : null}
            {!running && entry.summary ? (
                <div className="line-clamp-3 whitespace-pre-wrap break-words text-[var(--app-fg)] opacity-80">{entry.summary}</div>
            ) : null}
        </div>
    )
}

/** Header chip listing every subagent of the session. */
export function SubagentsChip(props: { entries: Record<string, SubagentEntry>; ownerActive: boolean; onOpen: (sessionId: string) => void }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const menuId = useId()
    const entries = Object.values(props.entries).sort((a, b) => b.startedAt - a.startedAt)
    const runningCount = entries.filter((entry) => isSubagentRunning(entry, props.ownerActive)).length

    useEffect(() => {
        if (!open) return
        const close = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
        }
        const escape = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            setOpen(false)
            rootRef.current?.querySelector('button')?.focus()
        }
        window.addEventListener('pointerdown', close)
        window.addEventListener('keydown', escape)
        return () => {
            window.removeEventListener('pointerdown', close)
            window.removeEventListener('keydown', escape)
        }
    }, [open])

    useLayoutEffect(() => {
        if (!open) return
        const menu = menuRef.current
        const anchor = rootRef.current
        if (!menu || !anchor) return
        const viewport = window.visualViewport
        const position = () => {
            const rect = anchor.getBoundingClientRect()
            const leftEdge = (viewport?.offsetLeft ?? 0) + 8
            const topEdge = (viewport?.offsetTop ?? 0) + 8
            const width = Math.max(0, (viewport?.width ?? window.innerWidth) - 16)
            const height = Math.max(0, (viewport?.height ?? window.innerHeight) - 16)
            const bottomEdge = topEdge + height
            const above = Math.max(0, rect.top - topEdge - 4)
            const below = Math.max(0, bottomEdge - rect.bottom - 4)
            const openAbove = above > below
            menu.style.width = `${Math.min(384, width)}px`
            menu.style.maxHeight = `${Math.min(height * 0.6, openAbove ? above : below)}px`
            const bounds = menu.getBoundingClientRect()
            menu.style.left = `${Math.max(leftEdge, Math.min(rect.left, leftEdge + width - bounds.width))}px`
            menu.style.top = `${Math.max(topEdge, Math.min(openAbove ? rect.top - bounds.height - 4 : rect.bottom + 4, bottomEdge - bounds.height))}px`
        }
        position()
        const observer = new ResizeObserver(position)
        observer.observe(menu)
        window.addEventListener('resize', position)
        window.addEventListener('scroll', position, true)
        viewport?.addEventListener('resize', position)
        viewport?.addEventListener('scroll', position)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', position)
            window.removeEventListener('scroll', position, true)
            viewport?.removeEventListener('resize', position)
            viewport?.removeEventListener('scroll', position)
        }
    }, [open])

    if (entries.length === 0) return null

    return (
        <div ref={rootRef} className="relative ml-2">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                className={cn(
                    'rounded-full px-2 py-0.5 hover:text-[var(--app-link)]',
                    runningCount > 0 ? STATUS_CLASS.running : 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]'
                )}
            >
                {t('subagent.chip', { count: entries.length })}
                {runningCount > 0 ? ` · ${t('subagent.chip.running', { count: runningCount })}` : null}
            </button>
            {open ? createPortal(
                <div ref={menuRef} id={menuId} role="region" aria-label={t('subagent.chip', { count: entries.length })}
                    className="fixed z-[70] overflow-y-auto overscroll-contain rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-xl">
                    {entries.map((entry) => (
                        <button
                            key={`${entry.startedAt}-${entry.sessionId ?? entry.description}`}
                            type="button"
                            disabled={!entry.sessionId}
                            onClick={() => {
                                if (!entry.sessionId) return
                                setOpen(false)
                                props.onOpen(entry.sessionId)
                            }}
                            className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-[var(--app-secondary-bg)] disabled:opacity-60"
                        >
                            <span className="truncate text-sm text-[var(--app-fg)]">{entry.description ?? entry.agentType ?? t('subagent.label')}</span>
                            <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--app-hint)]">
                                <StatusBadge status={displayStatus(entry, props.ownerActive)} />
                                <SubagentStats entry={entry} />
                            </span>
                        </button>
                    ))}
                </div>,
                document.body
            ) : null}
        </div>
    )
}

/** Shown on top of a subagent's own read-only session. */
export function SubagentBanner(props: { entry: SubagentEntry | null; ownerActive: boolean }) {
    const { t } = useTranslation()
    const { entry } = props
    return (
        <div className="px-3 pt-3">
            <div className="mx-auto flex w-full max-w-content flex-col gap-1 rounded-md bg-[var(--app-subtle-bg)] p-3 text-xs text-[var(--app-hint)]">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-[var(--app-fg)]">{t('subagent.label')}</span>
                    {entry ? <StatusBadge status={displayStatus(entry, props.ownerActive)} /> : null}
                    {entry ? <SubagentStats entry={entry} /> : null}
                </div>
                {entry && isSubagentRunning(entry, props.ownerActive) && entry.activity ? (
                    <div className="truncate font-mono">{entry.activity}</div>
                ) : (
                    <div>{t('subagent.readOnly')}</div>
                )}
            </div>
        </div>
    )
}

/** Desktop slide-over showing a subagent session next to its parent. */
export function SubagentPanel(props: { onClose: () => void; children: ReactNode }) {
    const { onClose } = props
    const { t } = useTranslation()
    const { width, handleMouseDown, handleTouchStart } = useResizableWidth({
        storageKey: 'hapi-subagent-panel-width',
        min: 480,
        max: 1600,
        defaultWidth: 960,
        edge: 'left',
    })
    useEffect(() => {
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', closeOnEscape)
        return () => window.removeEventListener('keydown', closeOnEscape)
    }, [onClose])

    return (
        <div
            className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
            style={{ width: `min(${width}px, calc(100vw - 320px))` }}
        >
            <div
                className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-[var(--app-link)] active:bg-[var(--app-link)]"
                onMouseDown={handleMouseDown}
                onTouchStart={handleTouchStart}
                role="separator"
                aria-orientation="vertical"
                aria-label={t('subagent.resizePanel')}
            />
            {props.children}
        </div>
    )
}
