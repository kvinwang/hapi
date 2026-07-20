import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { SessionSummary, Machine } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { DeleteSessionDialog } from '@/components/DeleteSessionDialog'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionPropertiesDialog } from '@/components/SessionPropertiesDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { formatUsd } from '@/chat/usageCost'

type DirectoryGroup = {
    key: string
    directory: string
    displayName: string
    sessions: SessionSummary[]
    tree: SessionTreeNode[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

type MachineGroup = {
    key: string
    label: string
    directories: DirectoryGroup[]
    latestUpdatedAt: number
    hasActiveSession: boolean
    sessionsCount: number
}

type SessionTreeNode = {
    session: SessionSummary
    children: SessionTreeNode[]
    hasActiveDescendant: boolean
    hasSelectedDescendant: boolean
}

function getSessionSortTime(session: SessionSummary): number {
    // updatedAt = persisted “real” activity (messages/metadata/etc). activeAt = heartbeat; too noisy for ordering/UI.
    return session.updatedAt
}

function computeEffectiveSortTimes(sessions: SessionSummary[]): Map<string, number> {
    const sessionById = new Map(sessions.map(s => [s.id, s]))
    const childrenByParent = new Map<string, string[]>()
    for (const s of sessions) {
        if (s.parentSessionId && s.parentSessionId !== s.id && sessionById.has(s.parentSessionId)) {
            if (!childrenByParent.has(s.parentSessionId)) {
                childrenByParent.set(s.parentSessionId, [])
            }
            childrenByParent.get(s.parentSessionId)!.push(s.id)
        }
    }
    const result = new Map<string, number>()
    const visited = new Set<string>()
    const compute = (id: string): number => {
        if (result.has(id)) return result.get(id)!
        if (visited.has(id)) return getSessionSortTime(sessionById.get(id)!)
        visited.add(id)
        let maxTime = getSessionSortTime(sessionById.get(id)!)
        for (const childId of childrenByParent.get(id) ?? []) {
            maxTime = Math.max(maxTime, compute(childId))
        }
        result.set(id, maxTime)
        return maxTime
    }
    for (const s of sessions) {
        if (!result.has(s.id)) compute(s.id)
    }
    return result
}

function getSessionMachineLabel(session: SessionSummary): string {
    const machineId = session.metadata?.machineId?.trim()
    if (machineId) return machineId.slice(0, 8)

    return 'unknown'
}

function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function groupSessionsByMachine(
    sessions: SessionSummary[],
    machineTitleById: Map<string, string>,
    selectedSessionId?: string | null,
    effectiveSortTimes?: Map<string, number>
): MachineGroup[] {
    const getSortTime = (s: SessionSummary) => effectiveSortTimes?.get(s.id) ?? getSessionSortTime(s)
    const machineGroups = new Map<string, SessionSummary[]>()

    sessions.forEach(session => {
        const machineKey = session.metadata?.machineId ?? 'unknown'
        if (!machineGroups.has(machineKey)) {
            machineGroups.set(machineKey, [])
        }
        machineGroups.get(machineKey)!.push(session)
    })

    return Array.from(machineGroups.entries())
        .map(([machineKey, machineSessions]) => {
            const directoryGroups = new Map<string, SessionSummary[]>()
            machineSessions.forEach(session => {
                const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
                if (!directoryGroups.has(path)) {
                    directoryGroups.set(path, [])
                }
                directoryGroups.get(path)!.push(session)
            })

            const directories = Array.from(directoryGroups.entries())
                .map(([directory, groupSessions]) => {
                    const sortedSessions = [...groupSessions].sort((a, b) => {
                        const aPin = a.pinned ? 1 : 0
                        const bPin = b.pinned ? 1 : 0
                        if (aPin !== bPin) return bPin - aPin
                        const delta = getSortTime(b) - getSortTime(a)
                        if (delta !== 0) return delta
                        return a.id.localeCompare(b.id)
                    })
                    const latestUpdatedAt = groupSessions.reduce(
                        (max, s) => Math.max(max, getSortTime(s)),
                        -Infinity
                    )
                    const hasActiveSession = groupSessions.some(s => s.active)
                    const displayName = getGroupDisplayName(directory)

                    return {
                        key: `${machineKey}:${directory}`,
                        directory,
                        displayName,
                        sessions: sortedSessions,
                        tree: buildSessionTree(sortedSessions, selectedSessionId),
                        latestUpdatedAt,
                        hasActiveSession
                    }
                })
                .sort((a, b) => {
                    const delta = b.latestUpdatedAt - a.latestUpdatedAt
                    if (delta !== 0) return delta
                    return a.key.localeCompare(b.key)
                })

            const firstSession = machineSessions[0]
            const machineLabel = machineTitleById.get(machineKey) ?? (firstSession ? getSessionMachineLabel(firstSession) : 'unknown')
            const latestUpdatedAt = machineSessions.reduce(
                (max, s) => Math.max(max, getSortTime(s)),
                -Infinity
            )
            const hasActiveSession = machineSessions.some(s => s.active)

            return {
                key: machineKey,
                label: machineLabel,
                directories,
                latestUpdatedAt,
                hasActiveSession,
                sessionsCount: machineSessions.length
            }
        })
        .sort((a, b) => {
            const delta = b.latestUpdatedAt - a.latestUpdatedAt
            if (delta !== 0) return delta
            return a.key.localeCompare(b.key)
        })
}

function buildSessionTree(
    sessions: SessionSummary[],
    selectedSessionId?: string | null
): SessionTreeNode[] {
    const sortedSessions = [...sessions]
    const sessionIds = new Set(sortedSessions.map((session) => session.id))
    const childrenByParentId = new Map<string, SessionSummary[]>()

    for (const session of sortedSessions) {
        const parentId = session.parentSessionId
        if (!parentId || parentId === session.id || !sessionIds.has(parentId)) {
            continue
        }
        if (!childrenByParentId.has(parentId)) {
            childrenByParentId.set(parentId, [])
        }
        childrenByParentId.get(parentId)!.push(session)
    }

    const rootSessions = sortedSessions.filter((session) => {
        const parentId = session.parentSessionId
        return !parentId || parentId === session.id || !sessionIds.has(parentId)
    })

    const visited = new Set<string>()
    const buildNode = (session: SessionSummary): SessionTreeNode => {
        if (visited.has(session.id)) {
            return {
                session,
                children: [],
                hasActiveDescendant: session.active,
                hasSelectedDescendant: session.id === selectedSessionId
            }
        }
        visited.add(session.id)
        const children = (childrenByParentId.get(session.id) ?? []).map(buildNode)
        const hasSelectedDescendant = session.id === selectedSessionId || children.some((child) => child.hasSelectedDescendant)
        const hasActiveDescendant = session.active || children.some((child) => child.hasActiveDescendant)
        return {
            session,
            children,
            hasActiveDescendant,
            hasSelectedDescendant
        }
    }

    const roots = rootSessions.map(buildNode)
    for (const session of sortedSessions) {
        if (!visited.has(session.id)) {
            roots.push(buildNode(session))
        }
    }

    return roots
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

function BulbIcon(props: { className?: string }) {
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
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.2 1 2h6c0-.8.4-1.4 1-2a7 7 0 0 0-4-12Z" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
    )
}

function ComputerIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <rect width="18" height="12" x="3" y="4" rx="1" />
            <path d="M8 20h8M12 16v4" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

function getAgentLabel(session: SessionSummary): string {
    const flavor = session.metadata?.flavor?.trim()
    if (flavor) return flavor
    return 'unknown'
}

function getSessionDirName(session: SessionSummary): string {
    const path = session.metadata?.worktree?.basePath ?? session.metadata?.path
    if (!path) return session.id.slice(0, 8)
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] + '/' : path
}

function getSessionPathLabel(session: SessionSummary): string {
    return (
        session.metadata?.worktree?.basePath
        ?? session.metadata?.path
        ?? session.id
    )
}

function formatRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return null
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

type DropZone = 'sibling' | 'child' | null

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    onNewSession?: (options: { machineId?: string; directory?: string; sourceSessionId?: string }) => void
    showPath?: boolean
    showMachine?: boolean
    machineLabel?: string | null
    api: ApiClient | null
    selected?: boolean
    allSessions?: SessionSummary[]
    depth?: number
    hasChildren?: boolean
    isCollapsed?: boolean
    onToggleCollapse?: () => void
    onReparent?: (draggedSessionId: string, targetSessionId: string, zone: 'sibling' | 'child') => void
}) {
    const { t } = useTranslation()
    const {
        session: s,
        onSelect,
        showPath = true,
        showMachine = false,
        machineLabel = null,
        api,
        selected = false,
        allSessions = [],
        depth = 0,
        hasChildren = false,
        isCollapsed = false,
        onToggleCollapse,
        onReparent
    } = props
    const [dropZone, setDropZone] = useState<DropZone>(null)
    const itemRef = useRef<HTMLDivElement>(null)
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [propertiesOpen, setPropertiesOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [isShared, setIsShared] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const queryClient = useQueryClient()
    const { resumeSession, convertSession, archiveSession, reparentSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )
    const parentSession = s.parentSessionId ? allSessions.find((item) => item.id === s.parentSessionId) ?? null : null
    const childSessions = useMemo(
        () => allSessions.filter((item) => item.parentSessionId === s.id),
        [allSessions, s.id]
    )
    const descendantCount = useMemo(() => {
        const queue = [...childSessions]
        const seen = new Set<string>()
        let count = 0
        while (queue.length > 0) {
            const current = queue.shift()
            if (!current || seen.has(current.id)) continue
            seen.add(current.id)
            count += 1
            queue.push(...allSessions.filter((item) => item.parentSessionId === current.id))
        }
        return count
    }, [allSessions, childSessions])

    const handleResume = async () => {
        setActionError(null)
        try {
            const resumedSessionId = await resumeSession()
            onSelect(resumedSessionId)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Failed to revive session')
        }
    }

    const handleConvertToCodex = async () => {
        const convertedSessionId = await convertSession('codex')
        onSelect(convertedSessionId)
    }

    const handleConvertToClaude = async () => {
        const convertedSessionId = await convertSession('claude')
        onSelect(convertedSessionId)
    }

    const handlePin = async () => {
        if (!api) return
        await api.updateSessionUiState(s.id, { pinned: true })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const handleUnpin = async () => {
        if (!api) return
        await api.updateSessionUiState(s.id, { pinned: false })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const handleTogglePin = async () => {
        if (s.pinned) await handleUnpin()
        else await handlePin()
    }

    const handleShare = async () => {
        if (!api) return
        await api.shareSession(s.id)
        setIsShared(true)
    }

    const handleUnshare = async () => {
        if (!api) return
        await api.unshareSession(s.id)
        setIsShared(false)
    }

    useEffect(() => {
        if (!api) return
        if (!menuOpen && !propertiesOpen) return

        let cancelled = false
        void api.getSessionShareStatus(s.id).then((res) => {
            if (!cancelled) {
                setIsShared(Boolean(res.shareToken))
            }
        }).catch(() => {})

        return () => {
            cancelled = true
        }
    }, [api, s.id, menuOpen, propertiesOpen])

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            if (isDraggingRef.current) return
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen && !isDraggingRef.current) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const isDraggingRef = useRef(false)

    const handleDragStart = (e: React.DragEvent) => {
        isDraggingRef.current = true
        e.dataTransfer.setData('text/plain', s.id)
        e.dataTransfer.effectAllowed = 'move'
    }

    const handleDragEnd = () => {
        isDraggingRef.current = false
        setDropZone(null)
    }

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const rect = itemRef.current?.getBoundingClientRect()
        if (!rect) return
        const y = e.clientY - rect.top
        const zone: DropZone = y < rect.height / 2 ? 'sibling' : 'child'
        setDropZone(zone)
    }

    const handleDragLeave = () => {
        setDropZone(null)
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        const draggedId = e.dataTransfer.getData('text/plain')
        setDropZone(null)
        if (!draggedId || draggedId === s.id || !dropZone || !onReparent) return
        onReparent(draggedId, s.id, dropZone)
    }

    const sessionName = getSessionTitle(s)
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'

    const dropIndicatorClass = dropZone === 'sibling'
        ? 'ring-t-2 ring-[var(--app-link)]'
        : dropZone === 'child'
            ? 'bg-[var(--app-link)]/10'
            : ''

    return (
        <>
            <div
                ref={itemRef}
                draggable
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`session-list-item relative mx-2 my-1 w-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm transition-colors ${selected ? 'bg-[var(--app-secondary-bg)]' : ''} ${dropIndicatorClass}`}
                style={{
                    marginLeft: `${8 + depth * 8}px`,
                    marginBottom: hasChildren ? '16px' : '4px',
                    ...(dropZone === 'sibling' ? { boxShadow: 'inset 0 2px 0 0 var(--app-link)' } : {}),
                    ...(dropZone === 'child' ? { boxShadow: 'inset 0 0 0 2px var(--app-link)', borderRadius: '4px' } : {})
                }}
            >
                <button
                    type="button"
                    {...longPressHandlers}
                    className="flex min-w-0 w-full flex-col overflow-hidden rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none"
                    style={{
                        WebkitTouchCallout: 'none',
                        paddingLeft: '12px'
                    }}
                    aria-current={selected ? 'page' : undefined}
                >
                    <div className="flex w-full items-center justify-between gap-3 py-2 pr-3">
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                                <span
                                    className={`h-2 w-2 rounded-full ${statusDotClass}`}
                                />
                            </span>
                            <div className="truncate text-sm font-medium">
                                {s.pinned ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1 inline-block text-[var(--app-hint)] -mt-0.5"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h2V3H6v3h2a1 1 0 0 1 1 1z"/></svg>
                                ) : null}
                                {sessionName}
                            </div>
                        </div>
                        {s.totalCost !== undefined ? (
                            <span className="shrink-0 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                                {formatUsd(s.totalCost)}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex w-full min-w-0 items-center justify-between gap-2 border-t border-[var(--app-border)] py-2 pr-3 text-xs text-[var(--app-hint)]">
                        <div className="flex min-w-0 items-center gap-2">
                            {showPath ? (
                                <span className="flex w-28 min-w-0 shrink-0 items-center gap-1.5 font-semibold text-[var(--app-secondary-fg)]">
                                    <FolderIcon className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{getSessionDirName(s)}</span>
                                </span>
                            ) : null}
                            {showPath && showMachine ? <span className="h-4 w-px shrink-0 bg-[var(--app-border)]" /> : null}
                            {showMachine ? (
                                <span className="flex min-w-0 items-center gap-1.5">
                                    <ComputerIcon className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{machineLabel ?? getSessionMachineLabel(s)}</span>
                                </span>
                            ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {(() => {
                                const progress = getTodoProgress(s)
                                if (!progress) return null
                                return (
                                    <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                        <BulbIcon className="h-3 w-3" />
                                        {progress.completed}/{progress.total}
                                    </span>
                                )
                            })()}
                            {s.pendingRequestsCount > 0 ? (
                                <span className="text-[var(--app-badge-warning-text)]">
                                    {t('session.item.pending')} {s.pendingRequestsCount}
                                </span>
                            ) : null}
                            <span className="text-[var(--app-hint)]">
                                {formatRelativeTime(getSessionSortTime(s), t)}
                            </span>
                        </div>
                    </div>
                </button>
                {hasChildren ? (
                    <button
                        type="button"
                        onClick={() => onToggleCollapse?.()}
                        className="absolute bottom-0 left-1/2 z-10 flex -translate-x-1/2 translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-1.5 text-[11px] font-medium text-[var(--app-secondary-fg)] shadow-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        aria-label={isCollapsed
                            ? t('session.item.expandChildren', { count: childSessions.length })
                            : t('session.item.collapseChildren', { count: childSessions.length })}
                    >
                        <span>{isCollapsed
                            ? t('session.item.expandChildren', { count: childSessions.length })
                            : t('session.item.collapseChildren', { count: childSessions.length })}</span>
                        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? '' : 'rotate-180'}`} aria-hidden="true">
                            <path d="m6 8 4 4 4-4" />
                        </svg>
                    </button>
                ) : null}
            </div>

            {actionError ? (
                <div className="mx-3 mb-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                    {actionError}
                </div>
            ) : null}

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionId={s.id}
                sessionActive={s.active}
                sessionFlavor={s.metadata?.flavor ?? null}
                onNewSession={props.onNewSession ? () => props.onNewSession!({ machineId: s.metadata?.machineId ?? undefined, directory: s.metadata?.path ?? undefined }) : undefined}
                onProperties={() => setPropertiesOpen(true)}
                onResume={handleResume}
                onDetach={s.parentSessionId ? () => reparentSession(null) : undefined}
                onConvertToCodex={handleConvertToCodex}
                onConvertToClaude={handleConvertToClaude}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                onShare={handleShare}
                onUnshare={isShared ? handleUnshare : undefined}
                anchorPoint={menuAnchorPoint}
            />

            <SessionPropertiesDialog
                isOpen={propertiesOpen}
                onClose={() => setPropertiesOpen(false)}
                sessionId={s.id}
                sessionName={sessionName}
                pinned={!!s.pinned}
                shared={isShared}
                tags={s.tags ?? []}
                parentSession={parentSession ? { id: parentSession.id, title: getSessionTitle(parentSession) } : null}
                childSessions={childSessions.map((item) => ({ id: item.id, title: getSessionTitle(item) }))}
                api={api}
                onRename={renameSession}
                onTogglePin={handleTogglePin}
                onShare={handleShare}
                onUnshare={handleUnshare}
                onOpenSession={onSelect}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={childSessions.length > 0
                    ? t('dialog.archive.descriptionRecursive', { name: sessionName, descendants: descendantCount })
                    : t('dialog.archive.description', { name: sessionName })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <DeleteSessionDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                sessionName={sessionName}
                directChildCount={childSessions.length}
                descendantCount={descendantCount}
                isPending={isPending}
                onDeleteSingle={() => deleteSession(childSessions.length > 0 ? 'detach-children' : 'single')}
                onDeleteRecursive={() => deleteSession('recursive')}
            />
        </>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    machines?: Machine[]
    viewMode?: 'grouped' | 'flat'
    onSelect: (sessionId: string) => void
    onNewSession: (options?: { machineId?: string; directory?: string; sourceSessionId?: string }) => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    selectedSessionId?: string | null
    collapseAllToken?: number | null
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { renderHeader = true, api, selectedSessionId, viewMode = 'grouped' } = props
    const machineTitleById = useMemo(() => {
        const map = new Map<string, string>()
        for (const machine of props.machines ?? []) {
            map.set(machine.id, getMachineTitle(machine))
        }
        return map
    }, [props.machines])
    const effectiveSortTimes = useMemo(
        () => computeEffectiveSortTimes(props.sessions),
        [props.sessions]
    )
    const sortedSessions = useMemo(() => (
        [...props.sessions].sort((a, b) => {
            const aPin = a.pinned ? 1 : 0
            const bPin = b.pinned ? 1 : 0
            if (aPin !== bPin) return bPin - aPin
            const delta = (effectiveSortTimes.get(b.id) ?? getSessionSortTime(b)) - (effectiveSortTimes.get(a.id) ?? getSessionSortTime(a))
            if (delta !== 0) return delta
            return a.id.localeCompare(b.id)
        })
    ), [props.sessions, effectiveSortTimes])
    const flatTree = useMemo(
        () => buildSessionTree(sortedSessions, selectedSessionId),
        [sortedSessions, selectedSessionId]
    )
    const machineGroups = useMemo(
        () => groupSessionsByMachine(sortedSessions, machineTitleById, selectedSessionId, effectiveSortTimes),
        [sortedSessions, machineTitleById, selectedSessionId, effectiveSortTimes]
    )
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [machineCollapseOverrides, setMachineCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [sessionCollapseOverrides, setSessionCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const collapseAllTokenRef = useRef<number | null>(null)
    const isGroupCollapsed = (group: DirectoryGroup): boolean => {
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        return !group.hasActiveSession
    }
    const isMachineCollapsed = (group: MachineGroup): boolean => {
        const override = machineCollapseOverrides.get(group.key)
        if (override !== undefined) return override
        return !group.hasActiveSession
    }
    const isSessionCollapsed = (node: SessionTreeNode): boolean => {
        const override = sessionCollapseOverrides.get(node.session.id)
        if (override !== undefined) return override
        return !node.hasActiveDescendant && !node.hasSelectedDescendant
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }
    const toggleMachineGroup = (groupKey: string, isCollapsed: boolean) => {
        setMachineCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }
    const toggleSessionNode = (sessionId: string, isCollapsed: boolean) => {
        setSessionCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(sessionId, !isCollapsed)
            return next
        })
    }

    const collapsibleSessionIds = useMemo(() => {
        const ids = new Set<string>()
        const collect = (nodes: SessionTreeNode[]) => {
            for (const node of nodes) {
                if (node.children.length > 0) {
                    ids.add(node.session.id)
                    collect(node.children)
                }
            }
        }
        collect(flatTree)
        for (const machine of machineGroups) {
            for (const group of machine.directories) {
                collect(group.tree)
            }
        }
        return ids
    }, [flatTree, machineGroups])

    useEffect(() => {
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownGroups = new Set(
                machineGroups.flatMap(group => group.directories.map(directory => directory.key))
            )
            let changed = false
            for (const groupKey of next.keys()) {
                if (!knownGroups.has(groupKey)) {
                    next.delete(groupKey)
                    changed = true
                }
            }
            return changed ? next : prev
        })
        setMachineCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownGroups = new Set(machineGroups.map(group => group.key))
            let changed = false
            for (const groupKey of next.keys()) {
                if (!knownGroups.has(groupKey)) {
                    next.delete(groupKey)
                    changed = true
                }
            }
            return changed ? next : prev
        })
        setSessionCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            let changed = false
            for (const sessionId of next.keys()) {
                if (!collapsibleSessionIds.has(sessionId)) {
                    next.delete(sessionId)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [machineGroups, collapsibleSessionIds])

    useEffect(() => {
        if (props.collapseAllToken === undefined || props.collapseAllToken === null) return
        if (collapseAllTokenRef.current === props.collapseAllToken) return
        collapseAllTokenRef.current = props.collapseAllToken
        setCollapseOverrides(() => new Map(
            machineGroups.flatMap(group => group.directories.map(directory => [directory.key, true]))
        ))
        setMachineCollapseOverrides(() => new Map(
            machineGroups.map(group => [group.key, true])
        ))
        setSessionCollapseOverrides(() => new Map(
            Array.from(collapsibleSessionIds, (sessionId) => [sessionId, true])
        ))
    }, [props.collapseAllToken, machineGroups, collapsibleSessionIds])

    const handleReparent = async (draggedSessionId: string, targetSessionId: string, zone: 'sibling' | 'child') => {
        if (!api) return
        const targetSession = sortedSessions.find(s => s.id === targetSessionId)
        if (!targetSession) return
        const newParentId = zone === 'child' ? targetSessionId : (targetSession.parentSessionId ?? null)
        if (draggedSessionId === newParentId) return
        await api.reparentSession(draggedSessionId, newParentId)
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const renderSessionTree = (
        nodes: SessionTreeNode[],
        options: {
            depth?: number
            showMachine?: boolean
            showPath?: boolean
        } = {}
    ): ReactNode => nodes.map((node) => {
        const isCollapsed = node.children.length > 0 ? isSessionCollapsed(node) : false
        const depth = options.depth ?? 0
        return (
            <div key={node.session.id} className="border-b border-[var(--app-divider)]">
                <SessionItem
                    session={node.session}
                    onSelect={props.onSelect}
                    onNewSession={props.onNewSession}
                    showMachine={Boolean(options.showMachine) && depth === 0}
                    machineLabel={options.showMachine ? (machineTitleById.get(node.session.metadata?.machineId ?? '') ?? null) : null}
                    showPath={options.showPath !== false && depth === 0}
                    api={api}
                    selected={node.session.id === selectedSessionId}
                    allSessions={sortedSessions}
                    depth={depth}
                    hasChildren={node.children.length > 0}
                    isCollapsed={isCollapsed}
                    onToggleCollapse={node.children.length > 0 ? () => toggleSessionNode(node.session.id, isCollapsed) : undefined}
                    onReparent={handleReparent}
                />
                {node.children.length > 0 && !isCollapsed ? (
                    <div className="flex flex-col">
                        {renderSessionTree(node.children, {
                            ...options,
                            depth: depth + 1,
                            showMachine: false,
                            showPath: false
                        })}
                    </div>
                ) : null}
            </div>
        )
    })

    return (
        <div className="mx-auto w-full max-w-content flex flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-3 py-1">
                    <div className="text-xs text-[var(--app-hint)]">
                        {t('sessions.count', { n: props.sessions.length, m: machineGroups.length })}
                    </div>
                    <button
                        type="button"
                        onClick={() => props.onNewSession()}
                        className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                        title={t('sessions.new')}
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            <div className="flex flex-col">
                {viewMode === 'flat' ? (
                    <div className="flex flex-col border-b border-[var(--app-divider)]">
                        {renderSessionTree(flatTree, { showMachine: true, showPath: true })}
                    </div>
                ) : (
                    <>
                        {machineGroups.map((machine) => {
                            const isMachineFolded = isMachineCollapsed(machine)
                            return (
                                <div key={machine.key} className="border-b border-[var(--app-divider)]">
                                    <button
                                        type="button"
                                        onClick={() => toggleMachineGroup(machine.key, isMachineFolded)}
                                        className="sticky top-0 z-10 flex w-full items-center gap-2 px-3 py-2 text-left bg-[var(--app-secondary-bg)] border-b border-[var(--app-divider)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                                    >
                                        <ChevronIcon
                                            className="h-4 w-4 text-[var(--app-hint)]"
                                            collapsed={isMachineFolded}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="font-semibold text-sm break-words">
                                                {t('misc.machine')}: {machine.label}
                                            </div>
                                        </div>
                                        <span className="shrink-0 text-xs text-[var(--app-hint)]">
                                            ({machine.sessionsCount})
                                        </span>
                                    </button>
                                    {!isMachineFolded ? (
                                        <>
                                            {machine.directories.map((group) => {
                                                const isCollapsed = isGroupCollapsed(group)
                                                return (
                                                    <div key={group.key}>
                                                        <div className="sticky top-0 z-10 flex w-full items-center gap-2 px-3 py-2 text-left bg-[var(--app-bg)] border-b border-[var(--app-divider)] transition-colors hover:bg-[var(--app-secondary-bg)]">
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleGroup(group.key, isCollapsed)}
                                                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                                            >
                                                                <ChevronIcon
                                                                    className="h-4 w-4 text-[var(--app-hint)]"
                                                                    collapsed={isCollapsed}
                                                                />
                                                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                                                    <div className="min-w-0">
                                                                        <div className="font-medium text-base break-words" title={group.directory}>
                                                                            {group.displayName}
                                                                        </div>
                                                                    </div>
                                                                    <span className="shrink-0 text-xs text-[var(--app-hint)]">
                                                                        ({group.sessions.length})
                                                                    </span>
                                                                </div>
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => props.onNewSession({ machineId: machine.key, directory: group.directory })}
                                                                className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                                                                title={t('sessions.new')}
                                                            >
                                                                <PlusIcon className="h-4 w-4" />
                                                            </button>
                                                        </div>
                                                        {!isCollapsed ? (
                                                            <div className="flex flex-col border-b border-[var(--app-divider)]">
                                                                {renderSessionTree(group.tree, { showPath: false })}
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                )
                                            })}
                                        </>
                                    ) : null}
                                </div>
                            )
                        })}
                    </>
                )}
            </div>
        </div>
    )
}
