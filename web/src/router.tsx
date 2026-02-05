import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    Outlet,
    createRootRoute,
    createRoute,
    createRouter,
    useLocation,
    useMatchRoute,
    useNavigate,
    useParams,
} from '@tanstack/react-router'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { NewSession } from '@/components/NewSession'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { fetchLatestMessages, seedMessageWindowFromSession } from '@/lib/message-window-store'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'
import SettingsPage from '@/routes/settings'
import QrConfirmPage from '@/routes/qr-confirm'

function BackIcon(props: { className?: string }) {
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
            <polyline points="15 18 9 12 15 6" />
        </svg>
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

function EyeIcon(props: { className?: string; open?: boolean }) {
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
            {props.open ? (
                <>
                    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                    <circle cx="12" cy="12" r="3" />
                </>
            ) : (
                <>
                    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
                    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
                    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
                    <path d="m2 2 20 20" />
                </>
            )}
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

function MachineGroupIcon(props: { className?: string }) {
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
            <rect x="3" y="4" width="18" height="12" rx="2" ry="2" />
            <path d="M8 20h8" />
            <path d="M12 16v4" />
        </svg>
    )
}

const SIDEBAR_STORAGE_KEY = 'hapi-sidebar-width'
const SIDEBAR_MIN_WIDTH = 280
const SIDEBAR_MAX_WIDTH = 600
const SIDEBAR_DEFAULT_WIDTH = 420

function useSidebarResize() {
    const [width, setWidth] = useState(() => {
        try {
            const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY)
            if (saved) {
                const parsed = Number(saved)
                if (parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) return parsed
            }
        } catch { /* ignore */ }
        return SIDEBAR_DEFAULT_WIDTH
    })
    const isDragging = useRef(false)
    const startX = useRef(0)
    const startWidth = useRef(0)
    const latestWidth = useRef(width)

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault()
        isDragging.current = true
        startX.current = e.clientX
        startWidth.current = latestWidth.current
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
    }, [])

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return
            const delta = e.clientX - startX.current
            const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth.current + delta))
            latestWidth.current = newWidth
            setWidth(newWidth)
        }

        const handleMouseUp = () => {
            if (!isDragging.current) return
            isDragging.current = false
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
            try {
                localStorage.setItem(SIDEBAR_STORAGE_KEY, String(latestWidth.current))
            } catch { /* ignore */ }
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', handleMouseUp)
        return () => {
            window.removeEventListener('mousemove', handleMouseMove)
            window.removeEventListener('mouseup', handleMouseUp)
        }
    }, [])

    return { width, handleMouseDown }
}

function SessionsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const { machines } = useMachines(api, true)
    const { width: sidebarWidth, handleMouseDown } = useSidebarResize()

    const handleRefresh = useCallback(() => {
        void refetch()
    }, [refetch])

    const [hideArchived, setHideArchived] = useState(false)
    const [collapseAllToken, setCollapseAllToken] = useState(0)
    const [groupByMachine, setGroupByMachine] = useState(false)
    const filteredSessions = useMemo(
        () => hideArchived ? sessions.filter(s => s.active) : sessions,
        [sessions, hideArchived]
    )
    const projectCount = new Set(filteredSessions.map(s => s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other')).size
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const selectedSessionId = sessionMatch ? sessionMatch.sessionId : null
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'

    return (
        <div className="flex h-full min-h-0">
            <div
                className={`${isSessionsIndex ? 'flex' : 'hidden lg:flex'} w-full sidebar-resizable shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
            >
                <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center justify-between px-3 py-2">
                        <div className="text-xs text-[var(--app-hint)]">
                            {t('sessions.count', { n: filteredSessions.length, m: projectCount })}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setHideArchived(prev => !prev)}
                                className={`p-1.5 rounded-full transition-colors ${hideArchived ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                                title={hideArchived ? t('sessions.showArchived') : t('sessions.hideArchived')}
                            >
                                <EyeIcon className="h-5 w-5" open={!hideArchived} />
                            </button>
                            <button
                                type="button"
                                onClick={() => setCollapseAllToken((value) => value + 1)}
                                className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('sessions.collapseAll')}
                            >
                                <CollapseAllIcon className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setGroupByMachine((value) => !value)}
                                className={`p-1.5 rounded-full transition-colors ${groupByMachine ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                                title={groupByMachine ? t('sessions.groupByProject') : t('sessions.groupByMachine')}
                            >
                                <MachineGroupIcon className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/settings' })}
                                className="p-1.5 rounded-full text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('settings.title')}
                            >
                                <SettingsIcon className="h-5 w-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/sessions/new' })}
                                className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                                title={t('sessions.new')}
                            >
                                <PlusIcon className="h-5 w-5" />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto desktop-scrollbar-left">
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    <SessionList
                        sessions={filteredSessions}
                        machines={machines}
                        collapseAllToken={collapseAllToken}
                        groupByMachine={groupByMachine}
                        selectedSessionId={selectedSessionId}
                        onSelect={(sessionId) => navigate({
                            to: '/sessions/$sessionId',
                            params: { sessionId },
                        })}
                        onNewSession={() => navigate({ to: '/sessions/new' })}
                        onRefresh={handleRefresh}
                        isLoading={isLoading}
                        renderHeader={false}
                        api={api}
                    />
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="hidden lg:flex w-1 shrink-0 cursor-col-resize items-center justify-center hover:bg-[var(--app-link)] active:bg-[var(--app-link)] transition-colors group relative"
                onMouseDown={handleMouseDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
            >
                <div className="absolute inset-y-0 -left-1 -right-1" />
                <div className="w-px h-full bg-[var(--app-divider)] group-hover:bg-transparent group-active:bg-transparent" />
            </div>

            <div className={`${isSessionsIndex ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
        </div>
    )
}

function SessionsIndexPage() {
    return null
}

function SessionPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const {
        session,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
        pendingCount,
        messagesVersion,
        flushPending,
        setAtBottom,
    } = useMessages(api, sessionId)
    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId, {
        resolveSessionId: async (currentSessionId) => {
            if (!api || !session || session.active) {
                return currentSessionId
            }
            try {
                return await api.resumeSession(currentSessionId)
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Resume failed'
                addToast({
                    title: 'Resume failed',
                    body: message,
                    sessionId: currentSessionId,
                    url: ''
                })
                throw error
            }
        },
        onSessionResolved: (resolvedSessionId) => {
            void (async () => {
                if (api) {
                    if (session && resolvedSessionId !== session.id) {
                        seedMessageWindowFromSession(session.id, resolvedSessionId)
                        queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
                            session: { ...session, id: resolvedSessionId, active: true }
                        })
                    }
                    try {
                        await Promise.all([
                            queryClient.prefetchQuery({
                                queryKey: queryKeys.session(resolvedSessionId),
                                queryFn: () => api.getSession(resolvedSessionId),
                            }),
                            fetchLatestMessages(api, resolvedSessionId),
                        ])
                    } catch {
                    }
                }
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: resolvedSessionId },
                    replace: true
                })
            })()
        },
        onBlocked: (reason) => {
            if (reason === 'no-api') {
                addToast({
                    title: t('send.blocked.title'),
                    body: t('send.blocked.noConnection'),
                    sessionId: sessionId ?? '',
                    url: ''
                })
            }
            // 'no-session' and 'pending' don't need toast - either invalid state or expected behavior
        }
    })

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)
    const {
        getSuggestions: getSkillSuggestions,
    } = useSkills(api, sessionId)

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [getSkillSuggestions, getSlashSuggestions])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    if (!session) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Loading session…" className="text-sm" />
            </div>
        )
    }

    return (
        <SessionChat
            api={api}
            session={session}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            isLoadingMessages={messagesLoading}
            isLoadingMoreMessages={messagesLoadingMore}
            isSending={isSending}
            pendingCount={pendingCount}
            messagesVersion={messagesVersion}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onSend={sendMessage}
            onFlushPending={flushPending}
            onAtBottomChange={setAtBottom}
            onRetryMessage={retryMessage}
            autocompleteSuggestions={getAutocompleteSuggestions}
        />
    )
}

type WorkspaceTabId = 'chat' | 'files' | 'terminal'

function ChatIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function FilesIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
        </svg>
    )
}

function TerminalIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
    )
}

function SessionWorkspace(props: { sessionId: string; activeTab: WorkspaceTabId }) {
    const navigate = useNavigate()
    const { activeTab, sessionId } = props
    const [mobileTabsVisible, setMobileTabsVisible] = useState(false)
    const mobileAnchorRef = useRef<HTMLElement | null>(null)
    const dragStateRef = useRef<{ pointerId: number; dx: number; dy: number; width: number; height: number } | null>(null)
    const [mobilePosition, setMobilePosition] = useState(() => {
        if (typeof window === 'undefined') {
            return { x: 8, y: 180 }
        }
        return { x: 8, y: Math.max(80, (window.innerHeight / 2) - 80) }
    })

    const goTab = useCallback((tab: WorkspaceTabId) => {
        if (tab === 'chat') {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
                replace: true
            })
            return
        }
        if (tab === 'files') {
            navigate({
                to: '/sessions/$sessionId/files',
                params: { sessionId },
                replace: true
            })
            return
        }
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId },
            replace: true
        })
    }, [navigate, sessionId])

    useEffect(() => {
        if (!mobileTabsVisible) {
            return
        }
        const timer = window.setTimeout(() => {
            setMobileTabsVisible(false)
        }, 2500)
        return () => window.clearTimeout(timer)
    }, [mobileTabsVisible, activeTab])

    const showMobileTabs = useCallback(() => {
        setMobileTabsVisible(true)
    }, [])

    const clampMobilePosition = useCallback((x: number, y: number, width: number, height: number) => {
        const pad = 8
        const maxX = Math.max(pad, window.innerWidth - width - pad)
        const maxY = Math.max(pad, window.innerHeight - height - pad)
        return {
            x: Math.min(Math.max(pad, x), maxX),
            y: Math.min(Math.max(pad, y), maxY)
        }
    }, [])

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            const drag = dragStateRef.current
            if (!drag) {
                return
            }
            const next = clampMobilePosition(
                event.clientX - drag.dx,
                event.clientY - drag.dy,
                drag.width,
                drag.height
            )
            setMobilePosition(next)
        }
        const onPointerUp = (event: PointerEvent) => {
            const drag = dragStateRef.current
            if (!drag || drag.pointerId !== event.pointerId) {
                return
            }
            dragStateRef.current = null
        }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
        return () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
        }
    }, [clampMobilePosition])

    useEffect(() => {
        const onResize = () => {
            const el = mobileAnchorRef.current
            if (!el) {
                return
            }
            const rect = el.getBoundingClientRect()
            setMobilePosition((prev) => clampMobilePosition(prev.x, prev.y, rect.width, rect.height))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [clampMobilePosition])

    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            const el = mobileAnchorRef.current
            if (!el) {
                return
            }
            const rect = el.getBoundingClientRect()
            setMobilePosition((prev) => clampMobilePosition(prev.x, prev.y, rect.width, rect.height))
        })
        return () => window.cancelAnimationFrame(frame)
    }, [mobileTabsVisible, clampMobilePosition])

    const startDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const el = mobileAnchorRef.current
        if (!el) {
            return
        }
        const rect = el.getBoundingClientRect()
        dragStateRef.current = {
            pointerId: event.pointerId,
            dx: event.clientX - rect.left,
            dy: event.clientY - rect.top,
            width: rect.width,
            height: rect.height
        }
        event.preventDefault()
    }, [])

    return (
        <div className="relative flex h-full min-h-0">
            <div className="hidden w-12 shrink-0 flex-col items-center gap-2 border-r border-[var(--app-border)] bg-[var(--app-bg)] py-3 md:flex">
                <button
                    type="button"
                    onClick={() => goTab('chat')}
                    className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${activeTab === 'chat' ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'}`}
                    title="Chat"
                >
                    <ChatIcon />
                </button>
                <button
                    type="button"
                    onClick={() => goTab('files')}
                    className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${activeTab === 'files' ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'}`}
                    title="Files"
                >
                    <FilesIcon />
                </button>
                <button
                    type="button"
                    onClick={() => goTab('terminal')}
                    className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${activeTab === 'terminal' ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'}`}
                    title="Terminal"
                >
                    <TerminalIcon />
                </button>
            </div>
            {mobileTabsVisible ? (
                <div
                    ref={(el) => {
                        mobileAnchorRef.current = el
                    }}
                    className="fixed z-40 flex flex-col items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/95 p-1 shadow-lg backdrop-blur md:hidden"
                    style={{ left: mobilePosition.x, top: mobilePosition.y }}
                >
                    <button
                        type="button"
                        onPointerDown={startDrag}
                        className="flex h-4 w-9 items-center justify-center rounded-md text-[var(--app-hint)] active:bg-[var(--app-subtle-bg)] touch-none"
                        aria-label="Drag tabs"
                        title="Drag"
                    >
                        <span className="h-0.5 w-4 rounded-full bg-current opacity-70" />
                    </button>
                    <button
                        type="button"
                        onClick={() => goTab('chat')}
                        className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${activeTab === 'chat' ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        title="Chat"
                    >
                        <ChatIcon />
                    </button>
                    <button
                        type="button"
                        onClick={() => goTab('files')}
                        className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${activeTab === 'files' ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        title="Files"
                    >
                        <FilesIcon />
                    </button>
                    <button
                        type="button"
                        onClick={() => goTab('terminal')}
                        className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${activeTab === 'terminal' ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                        title="Terminal"
                    >
                        <TerminalIcon />
                    </button>
                </div>
            ) : (
                <button
                    ref={(el) => {
                        mobileAnchorRef.current = el
                    }}
                    type="button"
                    onClick={showMobileTabs}
                    className="fixed z-40 flex h-9 w-6 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[var(--app-hint)] shadow-lg backdrop-blur md:hidden"
                    style={{ left: mobilePosition.x, top: mobilePosition.y }}
                    title="Show tabs"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                    </svg>
                </button>
            )}
            <div className={`min-h-0 flex-1 ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
                <SessionPage />
            </div>
            <div className={`min-h-0 flex-1 ${activeTab === 'files' ? 'block' : 'hidden'}`}>
                <FilesPage sessionId={sessionId} embedded />
            </div>
            <div className={`min-h-0 flex-1 ${activeTab === 'terminal' ? 'block' : 'hidden'}`}>
                <TerminalPage sessionId={sessionId} embedded />
            </div>
        </div>
    )
}

function SessionDetailRoute() {
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const basePath = `/sessions/${sessionId}`
    const isFile = pathname === `${basePath}/file`
    if (isFile) {
        return <Outlet />
    }
    const activeTab: WorkspaceTabId = pathname === `${basePath}/terminal`
        ? 'terminal'
        : pathname === `${basePath}/files`
            ? 'files'
            : 'chat'
    return <SessionWorkspace sessionId={sessionId} activeTab={activeTab} />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)

    const handleCancel = useCallback(() => {
        navigate({ to: '/sessions' })
    }, [navigate])

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({ to: '/sessions', replace: true })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
            })
        })
    }, [navigate, queryClient])

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">Create Session</div>
            </div>

            {machinesError ? (
                <div className="p-3 text-sm text-red-600">
                    {machinesError}
                </div>
            ) : null}

            <NewSession
                api={api}
                machines={machines}
                isLoading={machinesLoading}
                onCancel={handleCancel}
                onSuccess={handleSuccess}
            />
        </div>
    )
}

const rootRoute = createRootRoute({
    component: App,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

const sessionsIndexRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '/',
    component: SessionsIndexPage,
})

const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '$sessionId',
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    component: FilesPage,
})

const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: TerminalPage,
})

type SessionFileSearch = {
    path: string
    staged?: boolean
}

const sessionFileRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        return staged === undefined ? { path } : { path, staged }
    },
    component: FilePage,
})

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    component: NewSessionPage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
})

type QrConfirmSearch = {
    s?: string
}

const qrConfirmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/qr/$qrId',
    validateSearch: (search: Record<string, unknown>): QrConfirmSearch => ({
        s: typeof search.s === 'string' ? search.s : undefined,
    }),
    component: QrConfirmPage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute.addChildren([
        sessionsIndexRoute,
        newSessionRoute,
        sessionDetailRoute.addChildren([
            sessionTerminalRoute,
            sessionFilesRoute,
            sessionFileRoute,
        ]),
    ]),
    settingsRoute,
    qrConfirmRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
