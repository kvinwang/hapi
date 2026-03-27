import { useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session, SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { DeleteSessionDialog } from '@/components/DeleteSessionDialog'
import { SessionPropertiesDialog } from '@/components/SessionPropertiesDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useSessions } from '@/hooks/queries/useSessions'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'

function getSessionTitle(
    session: Pick<Session, 'id' | 'metadata'> | Pick<SessionSummary, 'id' | 'metadata'>
): string {
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

function MoreVerticalIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
        </svg>
    )
}

export function SessionHeader(props: {
    session: Session
    onBack: () => void
    api: ApiClient | null
    onSessionDeleted?: () => void
    onShare?: () => void
    onUnshare?: () => void
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { session, api, onSessionDeleted } = props
    const title = useMemo(() => getSessionTitle(session), [session])
    const worktreeBranch = session.metadata?.worktree?.branch
    const resolvedModel = session.metadata?.resolvedModel?.trim() || null
    const resolvedModelProvider = session.metadata?.resolvedModelProvider?.trim() || null
    const resolvedModelDisplay = resolvedModel
        ? resolvedModelProvider
            ? `${resolvedModel} (${resolvedModelProvider})`
            : resolvedModel
        : t('loading')

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const [propertiesOpen, setPropertiesOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const queryClient = useQueryClient()
    const { sessions } = useSessions(api)
    const { resumeSession, convertSession, archiveSession, detachSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )

    const { data: uiState } = useQuery({
        queryKey: queryKeys.sessionUiState(session.id),
        queryFn: () => api!.getSessionUiState(session.id),
        enabled: !!api
    })
    const pinned = !!uiState?.pinned
    const tags = (uiState?.tags as string[] | undefined) ?? []
    const sessionById = useMemo(
        () => new Map(sessions.map((item) => [item.id, item])),
        [sessions]
    )
    const parentSession = session.parentSessionId ? sessionById.get(session.parentSessionId) ?? null : null
    const childSessions = useMemo(
        () => sessions.filter((item) => item.parentSessionId === session.id),
        [sessions, session.id]
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
            queue.push(...sessions.filter((item) => item.parentSessionId === current.id))
        }
        return count
    }, [childSessions, sessions])
    const lineage = useMemo(() => {
        const chain: Array<{ id: string; title: string }> = []
        let cursorId: string | null | undefined = session.parentSessionId
        const seen = new Set<string>([session.id])
        while (cursorId && !seen.has(cursorId)) {
            seen.add(cursorId)
            const item = sessionById.get(cursorId)
            if (!item) break
            chain.unshift({ id: item.id, title: getSessionTitle(item) })
            cursorId = item.parentSessionId
        }
        return chain
    }, [session.id, session.parentSessionId, sessionById])

    const handlePin = async () => {
        if (!api) return
        await api.updateSessionUiState(session.id, { pinned: true })
        await queryClient.invalidateQueries({ queryKey: ['session-ui-state', session.id] })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const handleUnpin = async () => {
        if (!api) return
        await api.updateSessionUiState(session.id, { pinned: false })
        await queryClient.invalidateQueries({ queryKey: ['session-ui-state', session.id] })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const handleTogglePin = async () => {
        if (pinned) await handleUnpin()
        else await handlePin()
    }

    const handleDelete = async () => {
        await deleteSession(childSessions.length > 0 ? 'detach-children' : 'single')
        onSessionDeleted?.()
    }

    const handleDeleteRecursive = async () => {
        await deleteSession('recursive')
        onSessionDeleted?.()
    }

    const handleResume = async () => {
        setActionError(null)
        try {
            const resumedSessionId = await resumeSession()
            if (resumedSessionId !== session.id) {
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: resumedSessionId },
                    replace: true
                })
            }
        } catch (error) {
            setActionError(error instanceof Error ? error.message : 'Failed to revive session')
        }
    }

    const handleConvertToCodex = async () => {
        const convertedSessionId = await convertSession('codex')
        if (convertedSessionId !== session.id) {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: convertedSessionId },
                replace: true
            })
        }
    }

    const handleConvertToClaude = async () => {
        const convertedSessionId = await convertSession('claude')
        if (convertedSessionId !== session.id) {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: convertedSessionId },
                replace: true
            })
        }
    }

    const handleNewSession = () => {
        navigate({
            to: '/sessions/new',
            search: {
                machineId: session.metadata?.machineId ?? undefined,
                path: session.metadata?.path ?? undefined,
            }
        })
    }

    const handleMenuToggle = () => {
        if (!menuOpen && menuAnchorRef.current) {
            const rect = menuAnchorRef.current.getBoundingClientRect()
            setMenuAnchorPoint({ x: rect.right, y: rect.bottom })
        }
        setMenuOpen((open) => !open)
    }

    // In Telegram, don't render header (Telegram provides its own)
    if (isTelegramApp()) {
        return null
    }

    return (
        <>
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="w-full flex items-center gap-2 p-3">
                    {/* Back button */}
                    <button
                        type="button"
                        onClick={props.onBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
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
                        >
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>

                    {/* Session info - two lines: title and path */}
                    <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex flex-wrap items-center gap-1 text-xs text-[var(--app-hint)]">
                            <span>{t('session.family.root')}</span>
                            {lineage.map((item) => (
                                <span key={item.id} className="inline-flex items-center gap-1 min-w-0">
                                    <span aria-hidden="true">/</span>
                                    <button
                                        type="button"
                                        onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: item.id } })}
                                        className="truncate hover:text-[var(--app-link)]"
                                    >
                                        {item.title}
                                    </button>
                                </span>
                            ))}
                            {childSessions.length > 0 ? (
                                <button
                                    type="button"
                                    onClick={() => setPropertiesOpen(true)}
                                    className="ml-2 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[var(--app-hint)] hover:text-[var(--app-link)]"
                                >
                                    {t('session.family.children', { count: childSessions.length })}
                                </button>
                            ) : null}
                        </div>
                        <div className="truncate font-semibold">
                            {title}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--app-hint)]">
                            <span className="inline-flex items-center gap-1">
                                <span aria-hidden="true">❖</span>
                                {session.metadata?.flavor?.trim() || 'unknown'}
                            </span>
                            <span>
                                {t('session.item.modelMode')}: {session.modelMode || 'default'}
                            </span>
                            <span>
                                {t('session.item.model')}: {resolvedModelDisplay}
                            </span>
                            {worktreeBranch ? (
                                <span>{t('session.item.worktree')}: {worktreeBranch}</span>
                            ) : null}
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={handleMenuToggle}
                        onPointerDown={(e) => e.stopPropagation()}
                        ref={menuAnchorRef}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-controls={menuOpen ? menuId : undefined}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title={t('session.more')}
                    >
                        <MoreVerticalIcon />
                    </button>
                </div>
            </div>

            {actionError ? (
                <div className="mx-3 mb-1 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                    {actionError}
                </div>
            ) : null}

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionId={session.id}
                sessionActive={session.active}
                sessionFlavor={session.metadata?.flavor ?? null}
                onNewSession={handleNewSession}
                onProperties={() => setPropertiesOpen(true)}
                onResume={handleResume}
                onDetach={session.parentSessionId ? () => detachSession() : undefined}
                onConvertToCodex={handleConvertToCodex}
                onConvertToClaude={handleConvertToClaude}
                onArchive={() => setArchiveOpen(true)}
                onDelete={() => setDeleteOpen(true)}
                onShare={props.onShare}
                onUnshare={props.onUnshare}
                anchorPoint={menuAnchorPoint}
                menuId={menuId}
            />

            <SessionPropertiesDialog
                isOpen={propertiesOpen}
                onClose={() => setPropertiesOpen(false)}
                sessionId={session.id}
                sessionName={title}
                pinned={pinned}
                shared={!!props.onUnshare}
                tags={tags}
                parentSession={parentSession ? { id: parentSession.id, title: getSessionTitle(parentSession) } : null}
                childSessions={childSessions.map((item) => ({ id: item.id, title: getSessionTitle(item) }))}
                api={api}
                onRename={renameSession}
                onTogglePin={handleTogglePin}
                onShare={props.onShare}
                onUnshare={props.onUnshare}
                onOpenSession={(sessionId) => navigate({ to: '/sessions/$sessionId', params: { sessionId } })}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={childSessions.length > 0
                    ? t('dialog.archive.descriptionRecursive', { name: title, descendants: descendantCount })
                    : t('dialog.archive.description', { name: title })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <DeleteSessionDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                sessionName={title}
                directChildCount={childSessions.length}
                descendantCount={descendantCount}
                isPending={isPending}
                onDeleteSingle={handleDelete}
                onDeleteRecursive={handleDeleteRecursive}
            />
        </>
    )
}
