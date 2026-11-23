import { DEFAULT_FAVORITE_LIST_ID } from '@hapi/protocol'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { EyeIcon, StarIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'
import type { FavoriteList } from '@/types/api'

type SessionListToolbarProps = {
    hideArchived: boolean
    listFilter: string
    lists: FavoriteList[]
    unreadCount: number
    viewMode: 'grouped' | 'flat'
    isRefreshing: boolean
    onToggleArchived: () => void
    onListFilterChange: (filter: string) => void
    onNewList: () => void
    onRenameList: (list: FavoriteList) => void
    onDeleteList: (list: FavoriteList) => void
    onNewSession: () => void
    onRefresh: () => void
    onToggleViewMode: () => void
    onCollapseAll: () => void
    onShared: () => void
    onSettings: () => void
    onCloseSidebar?: () => void
}

export function SessionListToolbar(props: SessionListToolbarProps) {
    const { t } = useTranslation()
    const [menuOpen, setMenuOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const menuId = useId()
    const iconClass = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
    const inactiveClass = 'text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'

    const closeMenu = () => {
        setMenuOpen(false)
        triggerRef.current?.focus()
    }

    useEffect(() => {
        if (!menuOpen) return
        menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setMenuOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
    }, [menuOpen])

    const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            closeMenu()
            return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        if (!items.length) return
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
    }

    const items = [
        { label: t(props.isRefreshing ? 'sessions.refreshing' : 'sessions.refresh'), icon: <RefreshIcon className="h-5 w-5" spinning={props.isRefreshing} />, action: props.onRefresh, disabled: props.isRefreshing },
        { label: t(props.viewMode === 'flat' ? 'sessions.viewGrouped' : 'sessions.viewFlat'), icon: props.viewMode === 'flat' ? <TreeIcon className="h-5 w-5" /> : <ListIcon className="h-5 w-5" />, action: props.onToggleViewMode },
        { label: t('sessions.collapseAll'), icon: <CollapseAllIcon className="h-5 w-5" />, action: props.onCollapseAll },
        { label: t('shared.title'), icon: <Share2Icon className="h-5 w-5" />, action: props.onShared },
        { label: t('settings.title'), icon: <SettingsIcon className="h-5 w-5" />, action: props.onSettings }
    ]

    return (
        <div
            className="relative flex items-center justify-end gap-2"
            onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false)
            }}
        >
            {props.onCloseSidebar ? (
                <button type="button" onClick={props.onCloseSidebar} className={`mr-auto ${iconClass} ${inactiveClass}`} title={t('sessions.hideSidebar')} aria-label={t('sessions.hideSidebar')}>
                    <span className="text-xl leading-none" aria-hidden="true">‹</span>
                </button>
            ) : null}
            <button
                type="button"
                onClick={props.onToggleArchived}
                className={`${iconClass} ${props.hideArchived ? 'text-[var(--app-link)]' : inactiveClass}`}
                title={t(props.hideArchived ? 'sessions.showArchived' : 'sessions.hideArchived')}
                aria-label={t(props.hideArchived ? 'sessions.showArchived' : 'sessions.hideArchived')}
                aria-pressed={!props.hideArchived}
            >
                <EyeIcon className="h-5 w-5" open={!props.hideArchived} />
            </button>
            <button type="button" onClick={props.onNewSession} className={`session-list-new-button ${iconClass} text-[var(--app-link)]`} title={t('sessions.new')} aria-label={t('sessions.new')}>
                <PlusIcon className="h-5 w-5" />
            </button>
            <FavoriteListMenu {...props} iconClass={`${iconClass} ${props.listFilter !== 'all' ? 'text-[var(--app-link)]' : inactiveClass}`} />
            <button
                ref={triggerRef}
                type="button"
                onClick={() => setMenuOpen(value => !value)}
                onKeyDown={event => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        setMenuOpen(true)
                    }
                }}
                className={`${iconClass} ${inactiveClass}`}
                title={t('sessions.more')}
                aria-label={t('sessions.more')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
            >
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                    <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
                </svg>
            </button>
            {menuOpen ? (
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label={t('sessions.more')}
                    onKeyDown={handleMenuKeyDown}
                    className="absolute right-0 top-full z-50 mt-1 max-h-[calc(100dvh-6rem)] w-56 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg"
                >
                    {items.map(item => (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            tabIndex={-1}
                            disabled={item.disabled}
                            onClick={() => {
                                closeMenu()
                                item.action()
                            }}
                            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-50"
                        >
                            <span className="shrink-0 text-[var(--app-hint)]" aria-hidden="true">{item.icon}</span>
                            {item.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
function FavoriteListMenu(props: SessionListToolbarProps & { iconClass: string }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [actionsFor, setActionsFor] = useState<string | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) {
            setActionsFor(null)
            return
        }
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
    }, [open])

    const filters = [
        { id: 'all', name: t('sessions.list.all') },
        { id: DEFAULT_FAVORITE_LIST_ID, name: t('sessions.list.default') },
        { id: 'favorites', name: t('sessions.list.favorites') },
        { id: 'unread', name: t('sessions.list.unread') },
        ...props.lists
    ]
    const custom = new Map(props.lists.map(list => [list.id, list]))
    const select = (filter: string) => {
        setOpen(false)
        props.onListFilterChange(filter)
    }
    const runAction = (action: () => void) => {
        setOpen(false)
        action()
    }
    const subItemClass = 'block w-full rounded-md py-1.5 pl-7 pr-3 text-left text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'

    return (
        <div ref={rootRef} className="relative" onKeyDown={event => event.key === 'Escape' && setOpen(false)}>
            <button type="button" onClick={() => setOpen(value => !value)} className={`relative ${props.iconClass}`} title={t('sessions.list.title')} aria-label={t('sessions.list.title')} aria-haspopup="menu" aria-expanded={open}>
                <StarIcon className="h-5 w-5" fill={props.listFilter !== 'all' ? 'currentColor' : 'none'} aria-hidden="true" />
                {props.unreadCount > 0 ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--app-link)]" aria-hidden="true" /> : null}
            </button>
            {open ? (
                <div role="menu" aria-label={t('sessions.list.title')} className="absolute right-0 top-full z-50 mt-1 max-h-[calc(100dvh-6rem)] w-52 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg">
                    {filters.map(filter => {
                        const list = custom.get(filter.id)
                        const expanded = actionsFor === filter.id
                        return (
                            <div key={filter.id}>
                                <div className={`flex items-center rounded-md hover:bg-[var(--app-subtle-bg)] ${props.listFilter === filter.id ? 'text-[var(--app-link)]' : ''}`}>
                                    <button type="button" role="menuitemradio" aria-checked={props.listFilter === filter.id} onClick={() => select(filter.id)} className="min-w-0 flex-1 break-words px-3 py-2 text-left text-sm">
                                        {filter.name}
                                        {filter.id === 'unread' && props.unreadCount > 0 ? <span className="ml-2 rounded-full bg-[var(--app-button)] px-1.5 text-xs text-[var(--app-button-text)]">{props.unreadCount}</span> : null}
                                    </button>
                                    {list ? (
                                        <button
                                            type="button"
                                            onClick={() => setActionsFor(expanded ? null : list.id)}
                                            className={`mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] ${expanded ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                                            title={t('sessions.more')}
                                            aria-label={t('sessions.more')}
                                            aria-expanded={expanded}
                                        >
                                            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                                                <circle cx="5" cy="12" r="1.75" /><circle cx="12" cy="12" r="1.75" /><circle cx="19" cy="12" r="1.75" />
                                            </svg>
                                        </button>
                                    ) : null}
                                </div>
                                {list && expanded ? <>
                                    <button type="button" role="menuitem" className={subItemClass} onClick={() => runAction(() => props.onRenameList(list))}>{t('sessions.list.rename')}</button>
                                    <button type="button" role="menuitem" className={subItemClass} onClick={() => runAction(() => props.onDeleteList(list))}>{t('sessions.list.delete')}</button>
                                </> : null}
                            </div>
                        )
                    })}
                    <button type="button" role="menuitem" onClick={() => { setOpen(false); props.onNewList() }} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">
                        <PlusIcon className="h-4 w-4" />
                        {t('sessions.list.new')}
                    </button>
                </div>
            ) : null}
        </div>
    )
}

function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function SettingsIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function Share2Icon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
            <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
        </svg>
    )
}

function RefreshIcon(props: { className?: string; spinning?: boolean }) {
    return (
        <svg
            className={props.spinning ? `${props.className ?? ''} animate-spin` : props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
            <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
        </svg>
    )
}

function CollapseAllIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="3" y="4" width="18" height="6" rx="2" />
            <rect x="3" y="14" width="18" height="6" rx="2" />
            <path d="m8 7 4 3 4-3" />
            <path d="m8 17 4 3 4-3" />
        </svg>
    )
}

function ListIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <circle cx="4" cy="6" r="1" />
            <circle cx="4" cy="12" r="1" />
            <circle cx="4" cy="18" r="1" />
        </svg>
    )
}

function TreeIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M12 3v6" />
            <path d="M5 9h14" />
            <path d="M8 9v12" />
            <path d="M16 9v12" />
            <path d="M8 21h8" />
        </svg>
    )
}


