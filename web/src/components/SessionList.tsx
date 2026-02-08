import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary, Machine } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation } from '@/lib/use-translation'

type DirectoryGroup = {
    key: string
    directory: string
    displayName: string
    sessions: SessionSummary[]
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

function getSessionSortRank(session: SessionSummary): number {
    if (session.active) {
        return session.pendingRequestsCount > 0 ? 0 : 1
    }
    return 2
}

function getSessionSortTime(session: SessionSummary): number {
    // updatedAt = persisted “real” activity (messages/metadata/etc). activeAt = heartbeat; too noisy for ordering/UI.
    return session.updatedAt
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
    machineTitleById: Map<string, string>
): MachineGroup[] {
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
                        const rankA = getSessionSortRank(a)
                        const rankB = getSessionSortRank(b)
                        if (rankA !== rankB) return rankA - rankB
                        return getSessionSortTime(b) - getSessionSortTime(a)
                    })
                    const latestUpdatedAt = groupSessions.reduce(
                        (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                        -Infinity
                    )
                    const hasActiveSession = groupSessions.some(s => s.active)
                    const displayName = getGroupDisplayName(directory)

                    return {
                        key: `${machineKey}:${directory}`,
                        directory,
                        displayName,
                        sessions: sortedSessions,
                        latestUpdatedAt,
                        hasActiveSession
                    }
                })
                .sort((a, b) => {
                    if (a.hasActiveSession !== b.hasActiveSession) {
                        return a.hasActiveSession ? -1 : 1
                    }
                    return b.latestUpdatedAt - a.latestUpdatedAt
                })

            const firstSession = machineSessions[0]
            const machineLabel = machineTitleById.get(machineKey) ?? (firstSession ? getSessionMachineLabel(firstSession) : 'unknown')
            const latestUpdatedAt = machineSessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
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
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
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

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    showMachine?: boolean
    machineLabel?: string | null
    api: ApiClient | null
    selected?: boolean
}) {
    const { t } = useTranslation()
    const { session: s, onSelect, showPath = true, showMachine = false, machineLabel = null, api, selected = false } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { resumeSession, archiveSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )

    const handleResume = async () => {
        const resumedSessionId = await resumeSession()
        onSelect(resumedSessionId)
    }

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const sessionName = getSessionTitle(s)
    const statusDotClass = s.active
        ? (s.thinking ? 'bg-[#007AFF]' : 'bg-[var(--app-badge-success-text)]')
        : 'bg-[var(--app-hint)]'
    return (
        <>
            <button
                type="button"
                {...longPressHandlers}
                className={`session-list-item flex w-full flex-col gap-1.5 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none ${selected ? 'bg-[var(--app-secondary-bg)]' : ''}`}
                style={{ WebkitTouchCallout: 'none' }}
                aria-current={selected ? 'page' : undefined}
            >
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                            <span
                                className={`h-2 w-2 rounded-full ${statusDotClass}`}
                            />
                        </span>
                        <div className="truncate text-base font-medium">
                            {sessionName}
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                        {s.thinking ? (
                            <span className="text-[#007AFF] animate-pulse">
                                {t('session.item.thinking')}
                            </span>
                        ) : null}
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
                {showMachine ? (
                    <div className="truncate text-xs text-[var(--app-hint)]">
                        {t('misc.machine')}: {machineLabel ?? getSessionMachineLabel(s)}
                    </div>
                ) : null}
                {showPath ? (
                    <div className="truncate text-xs text-[var(--app-hint)]">
                        {getSessionPathLabel(s)}
                    </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--app-hint)]">
                    <span className="inline-flex items-center gap-2">
                        <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
                            ❖
                        </span>
                        {getAgentLabel(s)}
                    </span>
                    <span>{t('session.item.modelMode')}: {s.modelMode || 'default'}</span>
                    {s.metadata?.worktree?.branch ? (
                        <span>{t('session.item.worktree')}: {s.metadata.worktree.branch}</span>
                    ) : null}
                </div>
            </button>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
                onRename={() => setRenameOpen(true)}
                onResume={handleResume}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={sessionName}
                onRename={renameSession}
                isPending={isPending}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: sessionName })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={t('dialog.delete.title')}
                description={t('dialog.delete.description', { name: sessionName })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={deleteSession}
                isPending={isPending}
                destructive
            />
        </>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    machines?: Machine[]
    viewMode?: 'grouped' | 'flat'
    onSelect: (sessionId: string) => void
    onNewSession: (options?: { machineId?: string; directory?: string }) => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    selectedSessionId?: string | null
    collapseAllToken?: number | null
}) {
    const { t } = useTranslation()
    const { renderHeader = true, api, selectedSessionId, viewMode = 'grouped' } = props
    const machineTitleById = useMemo(() => {
        const map = new Map<string, string>()
        for (const machine of props.machines ?? []) {
            map.set(machine.id, getMachineTitle(machine))
        }
        return map
    }, [props.machines])
    const sortedSessions = useMemo(() => (
        [...props.sessions].sort((a, b) => {
            const rankA = getSessionSortRank(a)
            const rankB = getSessionSortRank(b)
            if (rankA !== rankB) return rankA - rankB
            return getSessionSortTime(b) - getSessionSortTime(a)
        })
    ), [props.sessions])
    const machineGroups = useMemo(
        () => groupSessionsByMachine(sortedSessions, machineTitleById),
        [sortedSessions, machineTitleById]
    )
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const [machineCollapseOverrides, setMachineCollapseOverrides] = useState<Map<string, boolean>>(
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
    }, [machineGroups])

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
    }, [props.collapseAllToken, machineGroups])

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
                    <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)]">
                        {sortedSessions.map((s) => (
                            <SessionItem
                                key={s.id}
                                session={s}
                                onSelect={props.onSelect}
                                showMachine
                                machineLabel={machineTitleById.get(s.metadata?.machineId ?? '') ?? null}
                                showPath
                                api={api}
                                selected={s.id === selectedSessionId}
                            />
                        ))}
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
                                                            <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)]">
                                                                {group.sessions.map((s) => (
                                                                    <SessionItem
                                                                        key={s.id}
                                                                        session={s}
                                                                        onSelect={props.onSelect}
                                                                        showPath={false}
                                                                        api={api}
                                                                        selected={s.id === selectedSessionId}
                                                                    />
                                                                ))}
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
