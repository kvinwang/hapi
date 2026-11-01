import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
    useSearch,
} from '@tanstack/react-router'
import { SessionListToolbar } from '@/components/SessionListToolbar'
import { filterSessionList } from '@/lib/filter-session-list'
import { App } from '@/App'
import { SessionChat } from '@/components/SessionChat'
import { SessionList } from '@/components/SessionList'
import { NewSession } from '@/components/NewSession'
import { SessionSkeleton } from '@/components/SessionSkeleton'
import { SubagentPanel } from '@/components/Subagents/SubagentViews'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useResizableWidth } from '@/hooks/useResizableWidth'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { PullToRefreshIndicator } from '@/components/PullToRefreshIndicator'
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
import { WorkspaceFileSidebar } from '@/components/SessionFiles/WorkspaceFileSidebar'
import { MobileFileSidebar } from '@/components/SessionFiles/MobileFileSidebar'
import FilePage from '@/routes/sessions/file'
import TerminalPage from '@/routes/sessions/terminal'
import SettingsLayout, { SettingsHome } from '@/routes/settings'
import GeneralSettings from '@/routes/settings/sections/General'
import ChatSettings from '@/routes/settings/sections/Chat'
import ModelsSettings from '@/routes/settings/sections/Models'
import DevicesSettings from '@/routes/settings/sections/Devices'
import AddDevicePage from '@/routes/settings/sections/AddDevice'
import SessionsSettings from '@/routes/settings/sections/Sessions'
import AccountSettings from '@/routes/settings/sections/Account'
import AboutSettings from '@/routes/settings/sections/About'
import ProvidersPage from '@/routes/settings/providers'
import ApiKeysPage from '@/routes/settings/api-keys'
import MachinesPage from '@/routes/settings/machines'
import SpeakersPage from '@/routes/settings/speakers'
import QuickPhrasesPage from '@/routes/settings/phrases'
import SharedSessionPage from '@/routes/shared-session'
import { GuestSessionShell } from '@/routes/guest-session'
import SharedSessionsPage from '@/routes/shared-sessions'
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

const SIDEBAR_VISIBILITY_STORAGE_KEY = 'hapi-sidebar-visible'

interface SessionsLayoutContextValue {
    toggleSessionSidebar: () => void
    sessionSidebarActive: boolean
}

const SessionsLayoutContext = createContext<SessionsLayoutContextValue | null>(null)

function SessionsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const { machines } = useMachines(api, true)
    const { width: sidebarWidth, handleMouseDown, handleTouchStart } = useResizableWidth({
        storageKey: 'hapi-sidebar-width',
        min: 280,
        max: 600,
        defaultWidth: 340,
        edge: 'right',
    })
    const workspaceLayout = useWorkspaceLayout()
    const supportsPersistentSidebar = workspaceLayout.sessionSidebar === 'persistent'
    const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false)
    const [desktopSidebarVisible, setDesktopSidebarVisible] = useState(() => {
        try {
            return localStorage.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY) !== '0'
        } catch {
            return true
        }
    })

    useEffect(() => {
        try {
            localStorage.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, desktopSidebarVisible ? '1' : '0')
        } catch { /* ignore */ }
    }, [desktopSidebarVisible])

    useEffect(() => {
        if (!sessionDrawerOpen) return
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setSessionDrawerOpen(false)
        }
        window.addEventListener('keydown', closeOnEscape)
        return () => window.removeEventListener('keydown', closeOnEscape)
    }, [sessionDrawerOpen])

    const handleRefresh = useCallback(async () => {
        await refetch()
    }, [refetch])

    const {
        containerRef: sessionListScrollRef,
        state: pullToRefreshState,
        refresh: triggerRefresh,
    } = usePullToRefresh<HTMLDivElement>({ onRefresh: handleRefresh })
    const isRefreshing = pullToRefreshState.phase === 'refreshing'

    const HIDE_ARCHIVED_STORAGE_KEY = 'hapi:sessions:hide-archived'
    const [hideArchived, setHideArchived] = useState(() => {
        try {
            const raw = localStorage.getItem(HIDE_ARCHIVED_STORAGE_KEY)
            return raw === '1' || raw === 'true'
        } catch {
            return false
        }
    })
    useEffect(() => {
        try {
            localStorage.setItem(HIDE_ARCHIVED_STORAGE_KEY, hideArchived ? '1' : '0')
        } catch { /* ignore */ }
    }, [hideArchived])

    type SessionListViewMode = 'grouped' | 'flat'
    const SESSION_LIST_VIEW_MODE_STORAGE_KEY = 'hapi:sessions:view-mode'
    const [sessionListViewMode, setSessionListViewMode] = useState<SessionListViewMode>(() => {
        try {
            const raw = localStorage.getItem(SESSION_LIST_VIEW_MODE_STORAGE_KEY)
            return raw === 'flat' ? 'flat' : 'grouped'
        } catch {
            return 'grouped'
        }
    })
    useEffect(() => {
        try {
            localStorage.setItem(SESSION_LIST_VIEW_MODE_STORAGE_KEY, sessionListViewMode)
        } catch { /* ignore */ }
    }, [sessionListViewMode])

    const [collapseAllToken, setCollapseAllToken] = useState(0)
    const [tagSearch, setTagSearch] = useState('')
    const [favoritesOnly, setFavoritesOnly] = useState(false)
    const archivedFilteredSessions = useMemo(() => {
        if (!hideArchived) return sessions
        // Keep active sessions + dead ancestors of active sessions (to preserve tree hierarchy)
        const activeIds = new Set(sessions.filter(s => s.active).map(s => s.id))
        const keepIds = new Set(activeIds)
        const sessionById = new Map(sessions.map(s => [s.id, s]))
        for (const id of activeIds) {
            let cur = sessionById.get(id)
            while (cur?.parentSessionId && !keepIds.has(cur.parentSessionId)) {
                keepIds.add(cur.parentSessionId)
                cur = sessionById.get(cur.parentSessionId)
            }
        }
        return sessions.filter(s => keepIds.has(s.id))
    }, [sessions, hideArchived])
    const filteredSessions = useMemo(() => filterSessionList({
        sessions, archivedFilteredSessions, tagSearch, favoritesOnly
    }), [archivedFilteredSessions, sessions, tagSearch, favoritesOnly])
    const projectCount = new Set(filteredSessions.map(s => s.metadata?.worktree?.basePath ?? s.metadata?.path ?? 'Other')).size
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const currentSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const [lastSessionId, setLastSessionId] = useState<string | null>(currentSessionId)
    useEffect(() => {
        if (currentSessionId) setLastSessionId(currentSessionId)
    }, [currentSessionId])
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const selectedSessionId = currentSessionId ?? (isSessionsIndex ? lastSessionId : null)
    const isSessionDrawer = !isSessionsIndex && !supportsPersistentSidebar && sessionDrawerOpen
    const showSidebar = isSessionsIndex || isSessionDrawer || (supportsPersistentSidebar && desktopSidebarVisible)
    const showContent = !isSessionsIndex || supportsPersistentSidebar
    const toggleSessionSidebar = useCallback(() => {
        if (supportsPersistentSidebar) {
            setDesktopSidebarVisible((visible) => !visible)
        } else {
            setSessionDrawerOpen((open) => !open)
        }
    }, [supportsPersistentSidebar])

    return (
        <div className="doc-flow relative flex h-full min-h-0">
            {isSessionDrawer ? (
                <button
                    type="button"
                    className="hapi-drawer-overlay fixed inset-0 z-40 bg-black/50"
                    data-state="open"
                    onClick={() => setSessionDrawerOpen(false)}
                    aria-label={t('sessions.hideSidebar')}
                />
            ) : null}
            <div
                className={`${showSidebar ? 'flex' : 'hidden'} ${isSessionDrawer ? 'hapi-session-drawer fixed inset-y-0 left-0 z-50 w-[85vw] max-w-sm shadow-2xl' : 'w-full'} sidebar-resizable shrink-0 flex-col bg-[var(--app-bg)]`}
                data-state={isSessionDrawer ? 'open' : undefined}
                style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
            >
                <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2">
                        <SessionListToolbar
                            hideArchived={hideArchived}
                            favoritesOnly={favoritesOnly}
                            viewMode={sessionListViewMode}
                            isRefreshing={isRefreshing}
                            onToggleArchived={() => setHideArchived(value => !value)}
                            onToggleFavorites={() => setFavoritesOnly(value => !value)}
                            onNewSession={() => navigate({ to: '/sessions/new' })}
                            onRefresh={triggerRefresh}
                            onToggleViewMode={() => setSessionListViewMode(value => value === 'grouped' ? 'flat' : 'grouped')}
                            onCollapseAll={() => setCollapseAllToken(value => value + 1)}
                            onShared={() => navigate({ to: '/shared' })}
                            onSettings={() => navigate({ to: '/settings' })}
                            onCloseSidebar={isSessionDrawer ? () => setSessionDrawerOpen(false) : undefined}
                        />
                        <input
                            type="search"
                            value={tagSearch}
                            onChange={(event) => setTagSearch(event.target.value)}
                            placeholder={t('sessions.searchTags')}
                            aria-label={t('sessions.searchTags')}
                            className="mt-2 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)]"
                        />
                        <div className="text-xs text-[var(--app-hint)] mt-1">
                            {t('sessions.count', { n: filteredSessions.length, m: projectCount })}
                        </div>
                    </div>
                </div>

                <div ref={sessionListScrollRef} className="app-scroll-y flex-1 min-h-0 desktop-scrollbar-left">
                    <PullToRefreshIndicator state={pullToRefreshState} />
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    {showSidebar && (favoritesOnly && filteredSessions.length === 0 && !isLoading ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">
                            <p>{t('sessions.noFavorites')}</p>
                            <p className="mt-2">{t('sessions.noFavoritesHint')}</p>
                        </div>
                    ) : (
                        <SessionList
                            sessions={filteredSessions}
                            machines={machines}
                            viewMode={sessionListViewMode}
                            collapseAllToken={collapseAllToken}
                            selectedSessionId={selectedSessionId}
                            onSelect={(sessionId) => {
                                setSessionDrawerOpen(false)
                                navigate({
                                    to: '/sessions/$sessionId',
                                    params: { sessionId },
                                })
                            }}
                            onNewSession={(options) => navigate({
                                to: '/sessions/new',
                                search: options?.machineId || options?.directory || options?.sourceSessionId
                                    ? {
                                        machineId: options?.machineId,
                                        path: options?.directory,
                                        sourceSessionId: options?.sourceSessionId,
                                    }
                                    : undefined
                            })}
                            onRefresh={triggerRefresh}
                            isLoading={isLoading}
                            renderHeader={false}
                            api={api}
                        />
                    ))}
                </div>
            </div>

            {supportsPersistentSidebar && desktopSidebarVisible ? (
                <div
                    className="group relative flex w-1 shrink-0 cursor-col-resize items-center justify-center transition-colors hover:bg-[var(--app-link)] active:bg-[var(--app-link)]"
                    onMouseDown={handleMouseDown}
                    onTouchStart={handleTouchStart}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('sessions.resizeSidebar')}
                >
                    <div className="absolute inset-y-0 -left-2 -right-2" />
                    <div className="h-full w-px bg-[var(--app-divider)] group-hover:bg-transparent group-active:bg-transparent" />
                    {!isSessionsIndex ? (
                        <button
                            type="button"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => setDesktopSidebarVisible(false)}
                            className="absolute z-10 flex h-10 w-5 items-center justify-center rounded-r-md border border-l-0 border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-sm hover:text-[var(--app-fg)]"
                            title={t('sessions.hideSidebar')}
                            aria-label={t('sessions.hideSidebar')}
                        >
                            <span aria-hidden="true">‹</span>
                        </button>
                    ) : null}
                </div>
            ) : null}

            <div className={`${showContent ? 'flex' : 'hidden'} doc-flow min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="doc-flow flex-1 min-h-0">
                    <SessionsLayoutContext.Provider value={{
                        toggleSessionSidebar,
                        sessionSidebarActive: supportsPersistentSidebar ? desktopSidebarVisible : sessionDrawerOpen,
                    }}>
                        <Outlet />
                    </SessionsLayoutContext.Provider>
                </div>
            </div>

        </div>
    )
}

function SessionsIndexPage() {
    return null
}

function SessionPage() {
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    return <SessionView sessionId={sessionId} onBack={goBack} />
}

function SessionView(props: { sessionId: string; onBack: () => void; onOpenSubagent?: (sessionId: string) => void }) {
    const { sessionId, onBack: goBack } = props
    const { api, guest } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { subagentView } = useWorkspaceLayout()
    const [panelSessionId, setPanelSessionId] = useState<string | null>(null)
    const closePanel = useCallback(() => setPanelSessionId(null), [])
    const openSubagent = useCallback((subagentSessionId: string) => {
        if (subagentView === 'panel') {
            setPanelSessionId(subagentSessionId)
            return
        }
        navigate({ to: '/sessions/$sessionId', params: { sessionId: subagentSessionId } })
    }, [navigate, subagentView])
    const {
        session,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        isLoadingNewer: messagesLoadingNewer,
        hasMore: messagesHasMore,
        hasMoreNewer: messagesHasMoreNewer,
        loadMore: loadMoreMessages,
        loadNewer: loadNewerMessages,
        goToLatest: goToLatestMessages,
        jumpToMessage,
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
                if (!guest) {
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId: resolvedSessionId },
                        replace: true
                    })
                }
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
        commands: slashCommands,
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

    const handleForkFromMessage = useCallback(async (messageSeq: number) => {
        if (!api || !sessionId) return
        try {
            const newSessionId = await api.forkSession(sessionId, messageSeq)
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: newSessionId }
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Fork failed'
            addToast({
                title: 'Fork failed',
                body: message,
                sessionId: sessionId,
                url: ''
            })
        }
    }, [api, sessionId, queryClient, navigate, addToast])

    const handleForkFullHistory = useCallback(async (messageSeq: number) => {
        if (!api || !sessionId) return
        try {
            const newSessionId = await api.forkSession(sessionId, messageSeq, true)
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            navigate({ to: '/sessions/$sessionId', params: { sessionId: newSessionId } })
        } catch (error) {
            addToast({
                title: 'Fork failed',
                body: error instanceof Error ? error.message : 'Fork failed',
                sessionId,
                url: ''
            })
        }
    }, [api, sessionId, queryClient, navigate, addToast])

    const [isShared, setIsShared] = useState(false)

    // Check share status on mount
    useEffect(() => {
        if (!api || !sessionId || guest) return
        let cancelled = false
        void api.getSessionShareStatus(sessionId).then((res) => {
            if (!cancelled) setIsShared(Boolean(res.shareToken))
        }).catch(() => {})
        return () => { cancelled = true }
    }, [api, sessionId, guest])

    const handleShare = useCallback(async () => {
        if (!api || !sessionId) return
        try {
            // Enable sharing (idempotent — always sets share_token = sessionId)
            await api.shareSession(sessionId)
            setIsShared(true)
            const shareUrl = `${window.location.origin}/shared/${sessionId}`
            try {
                await navigator.clipboard.writeText(shareUrl)
                addToast({
                    title: t('share.copied'),
                    body: shareUrl,
                    sessionId,
                    url: ''
                })
            } catch {
                addToast({
                    title: t('share.created'),
                    body: shareUrl,
                    sessionId,
                    url: ''
                })
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Share failed'
            addToast({
                title: 'Share failed',
                body: message,
                sessionId,
                url: ''
            })
        }
    }, [api, sessionId, addToast, t])

    const handleUnshare = useCallback(async () => {
        if (!api || !sessionId) return
        try {
            await api.unshareSession(sessionId)
            setIsShared(false)
            addToast({
                title: t('share.removed'),
                body: '',
                sessionId,
                url: ''
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unshare failed'
            addToast({
                title: 'Unshare failed',
                body: message,
                sessionId,
                url: ''
            })
        }
    }, [api, sessionId, addToast, t])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    // `useSession` paints from the cached sessions list when it can, so this only runs for a deep
    // link or a cold cache. Show the page frame rather than a bare spinner — a back button the user
    // can actually press beats a blank screen.
    if (!session) {
        return <SessionSkeleton onBack={goBack} />
    }

    return (
        <>
        <SessionChat
            api={api}
            session={session}
            messages={messages}
            messagesWarning={messagesWarning}
            hasMoreMessages={messagesHasMore}
            hasMoreNewerMessages={messagesHasMoreNewer}
            isLoadingMessages={messagesLoading}
            isLoadingMoreMessages={messagesLoadingMore}
            isLoadingNewerMessages={messagesLoadingNewer}
            isSending={isSending}
            pendingCount={pendingCount}
            messagesVersion={messagesVersion}
            onBack={goBack}
            onRefresh={refreshSelectedSession}
            onLoadMore={loadMoreMessages}
            onLoadNewer={loadNewerMessages}
            onGoToLatest={goToLatestMessages}
            onJumpToMessage={jumpToMessage}
            onSend={sendMessage}
            onFlushPending={flushPending}
            onAtBottomChange={setAtBottom}
            onRetryMessage={retryMessage}
            onForkFromMessage={guest ? undefined : handleForkFromMessage}
            onForkFullHistory={guest ? undefined : handleForkFullHistory}
            onShare={guest ? undefined : handleShare}
            onUnshare={!guest && isShared ? handleUnshare : undefined}
            autocompleteSuggestions={getAutocompleteSuggestions}
            availableSlashCommands={slashCommands}
            // A guest's grant covers this session only, not its subagents' sessions.
            onOpenSubagent={guest ? undefined : props.onOpenSubagent ?? openSubagent}
        />
        {panelSessionId ? (
            <SubagentPanel onClose={closePanel}>
                {/* Nested subagents replace the panel's content instead of stacking panels. */}
                <SessionView key={panelSessionId} sessionId={panelSessionId} onBack={closePanel} onOpenSubagent={setPanelSessionId} />
            </SubagentPanel>
        ) : null}
        </>
    )
}

import type { WorkspaceTabId } from '@/components/Session/workspace-tabs'
import { WorkspaceTabBar, workspaceButtons } from '@/components/Session/WorkspaceTabBar'
import { PanelSections } from '@/components/Session/PanelSections'
import { ComposerDockContext } from '@/components/Session/composerDock'
import { DocumentScrollContext } from '@/components/Session/documentScroll'
import { VoiceEdgeGlow, VoiceOrb, VoiceOverlay, isVoiceEdgeGlowEnabled } from '@/components/VoiceOrb'
import { useOmniVoice } from '@/hooks/useOmniVoice'

function SessionWorkspace(props: { sessionId: string; activeTab: WorkspaceTabId; showFileOverlay?: boolean }) {
    const navigate = useNavigate()
    const sessionsLayout = useContext(SessionsLayoutContext)
    if (!sessionsLayout) throw new Error('SessionWorkspace must be rendered within SessionsPage')
    const { toggleSessionSidebar, sessionSidebarActive } = sessionsLayout
    const { activeTab, sessionId, showFileOverlay = false } = props
    const location = useLocation()
    const [mobileTabsVisible, setMobileTabsVisible] = useState(() => {
        if (typeof window === 'undefined') return true
        const stored = window.localStorage.getItem('hapi.mobileTabsVisible')
        if (stored === null) return true
        return stored === '1'
    })
    const [fileDrawerOpen, setFileDrawerOpen] = useState(false)
    const [composerDock, setComposerDock] = useState<HTMLElement | null>(null)
    const { api, baseUrl, token, guest } = useAppContext()
    const voice = useOmniVoice({ api, baseUrl, token, sessionId })
    const voiceOrb = (size: number) => guest ? null : (
        <VoiceOrb state={voice.state} micOn={voice.micOn} level={voice.level} size={size} onClick={voice.toggle} />
    )
    // All three panes used to mount at once and hide two with CSS, so opening a session fired the
    // file, git and terminal queries — and pulled in xterm — before the chat had any of its own data.
    // Mount a pane the first time its tab is selected, then keep it mounted so switching tabs stays
    // instant and the terminal keeps its session.
    const [mountedTabs, setMountedTabs] = useState<{ sessionId: string; tabs: WorkspaceTabId[] }>(
        () => ({ sessionId, tabs: [activeTab] })
    )
    if (mountedTabs.sessionId !== sessionId) {
        setMountedTabs({ sessionId, tabs: [activeTab] })
    } else if (!mountedTabs.tabs.includes(activeTab)) {
        setMountedTabs({ sessionId, tabs: [...mountedTabs.tabs, activeTab] })
    }
    const isTabMounted = (tab: WorkspaceTabId) => (
        tab === activeTab || (mountedTabs.sessionId === sessionId && mountedTabs.tabs.includes(tab))
    )
    const [desktopFileSidebarVisible, setDesktopFileSidebarVisible] = useState(() => {
        if (typeof window === 'undefined') return true
        const stored = window.localStorage.getItem('hapi.desktopFileSidebarVisible')
        if (stored === null) return true
        return stored === '1'
    })
    // The sidebar is `hidden lg:flex`, but CSS only hides it — on a phone it still mounted and ran
    // the directory queries for a panel nobody can see.
    const workspaceLayout = useWorkspaceLayout()
    const isDesktopFileLayout = workspaceLayout.fileSidebar === 'persistent'
    const mobileAnchorRef = useRef<HTMLElement | null>(null)
    const dragStateRef = useRef<{ pointerId: number; dx: number; dy: number; width: number; height: number; x: number; y: number; moved: boolean } | null>(null)
    const lastFilesTabKindRef = useRef<'files' | 'file'>('files')
    const lastFileSearchRef = useRef<{ path: string; staged?: boolean } | null>(null)
    const [mobilePosition, setMobilePosition] = useState(() => {
        if (typeof window === 'undefined') {
            return { x: 8, y: 180 }
        }
        const stored = window.localStorage.getItem('hapi.mobilePosition')
        if (stored) {
            try {
                const parsed = JSON.parse(stored)
                if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
                    return { x: parsed.x, y: parsed.y }
                }
            } catch {
                // ignore corrupted entry
            }
        }
        // Default: right edge, vertically centered. Anchor offset (~50px) keeps it on-screen.
        return {
            x: Math.max(8, window.innerWidth - 50),
            y: Math.max(80, (window.innerHeight / 2) - 80)
        }
    })

    useEffect(() => {
        const basePath = `/sessions/${sessionId}`
        if (location.pathname === `${basePath}/file`) {
            lastFilesTabKindRef.current = 'file'
            const params = typeof window === 'undefined'
                ? new URLSearchParams()
                : new URLSearchParams(window.location.search)
            const path = params.get('path')
            const stagedRaw = params.get('staged')
            const staged = stagedRaw === null
                ? undefined
                : stagedRaw === 'true' || stagedRaw === '1'
                    ? true
                    : stagedRaw === 'false' || stagedRaw === '0'
                        ? false
                        : undefined
            if (path) {
                lastFileSearchRef.current = staged === undefined
                    ? { path }
                    : { path, staged }
            }
            return
        }

        if (location.pathname === `${basePath}/files`) {
            lastFilesTabKindRef.current = 'files'
        }
    }, [location.pathname, sessionId])

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
            if (lastFilesTabKindRef.current === 'file' && lastFileSearchRef.current?.path) {
                navigate({
                    to: '/sessions/$sessionId/file',
                    params: { sessionId },
                    search: lastFileSearchRef.current,
                    replace: true
                })
                return
            }
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
        if (typeof window === 'undefined') return
        window.localStorage.setItem('hapi.mobileTabsVisible', mobileTabsVisible ? '1' : '0')
    }, [mobileTabsVisible])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem('hapi.mobilePosition', JSON.stringify(mobilePosition))
    }, [mobilePosition])

    useEffect(() => {
        if (typeof window === 'undefined') return
        window.localStorage.setItem('hapi.desktopFileSidebarVisible', desktopFileSidebarVisible ? '1' : '0')
    }, [desktopFileSidebarVisible])

    const toggleDesktopFileSidebar = useCallback(() => {
        setDesktopFileSidebarVisible((v) => !v)
    }, [])

    const showMobileTabs = useCallback(() => {
        setMobileTabsVisible(true)
    }, [])

    const hideMobileTabs = useCallback(() => {
        setMobileTabsVisible(false)
    }, [])

    const openFileDrawer = useCallback(() => {
        setFileDrawerOpen(true)
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
            if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) {
                return
            }
            drag.moved = true
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
            height: rect.height,
            x: event.clientX,
            y: event.clientY,
            moved: false
        }
        event.preventDefault()
    }, [])

    return (
        <div className="doc-flow relative flex h-full min-h-0">
            {isDesktopFileLayout ? (
                <div className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-[var(--app-border)] bg-[var(--app-bg)] py-3">
                    {voiceOrb(30)}
                    {activeTab === 'chat' ? <div ref={setComposerDock} className="flex flex-col items-center gap-2" /> : null}
                    <WorkspaceTabBar
                        activeTab={activeTab}
                        onChangeTab={goTab}
                        onTreeClick={toggleDesktopFileSidebar}
                        treeActive={desktopFileSidebarVisible}
                        onSessionsClick={toggleSessionSidebar}
                        sessionsActive={sessionSidebarActive}
                    />
                </div>
            ) : (
                // One floating panel in two sections (long-press a button to move it); collapsed shows the first.
                <div
                    ref={(el) => {
                        mobileAnchorRef.current = el
                    }}
                    className="fixed z-40 flex select-none flex-col items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/95 p-1 shadow-lg backdrop-blur"
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
                    <PanelSections
                        expanded={mobileTabsVisible}
                        items={{
                            voice: voiceOrb(34),
                            // In a hidden (collapsed) section the composer stays docked without showing its buttons.
                            composer: activeTab === 'chat'
                                ? <div ref={setComposerDock} className="flex flex-col items-center gap-2" />
                                : undefined,
                            ...workspaceButtons({
                                activeTab,
                                onChangeTab: goTab,
                                onTreeClick: openFileDrawer,
                                treeActive: fileDrawerOpen,
                                onSessionsClick: toggleSessionSidebar,
                                sessionsActive: sessionSidebarActive
                            })
                        }}
                    />
                    <button
                        type="button"
                        onClick={mobileTabsVisible ? hideMobileTabs : showMobileTabs}
                        className="flex h-7 w-9 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                        title={mobileTabsVisible ? 'Collapse' : 'Expand'}
                        aria-label={mobileTabsVisible ? 'Collapse tabs' : 'Expand tabs'}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points={mobileTabsVisible ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
                        </svg>
                    </button>
                </div>
            )}
            {guest ? null : (
                <VoiceOverlay
                    caption={voice.caption}
                    draft={voice.draft}
                    drafting={voice.drafting}
                    draftIssue={voice.draftIssue}
                    transcription={voice.transcription}
                    sending={voice.sending}
                    onSend={() => void voice.sendDraft()}
                    onClear={voice.clearDraft}
                />
            )}
            {guest || !isVoiceEdgeGlowEnabled() ? null : <VoiceEdgeGlow state={voice.state} micOn={voice.micOn} level={voice.level} />}
            <div className="doc-flow relative min-h-0 min-w-0 flex-1">
                {isTabMounted('chat') ? (
                    <div className={`doc-flow absolute inset-0 ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
                        <ComposerDockContext.Provider value={composerDock}>
                            <DocumentScrollContext.Provider value={workspaceLayout.composer === 'docked' && activeTab === 'chat' && !showFileOverlay}>
                                <SessionPage />
                            </DocumentScrollContext.Provider>
                        </ComposerDockContext.Provider>
                    </div>
                ) : null}
                {isTabMounted('files') ? (
                    <div className={`absolute inset-0 ${activeTab === 'files' ? 'block' : 'hidden'}`}>
                        <FilesPage sessionId={sessionId} embedded />
                    </div>
                ) : null}
                {isTabMounted('terminal') ? (
                    <div className={`absolute inset-0 ${activeTab === 'terminal' ? 'block' : 'hidden'}`}>
                        <TerminalPage sessionId={sessionId} embedded />
                    </div>
                ) : null}
                {showFileOverlay ? (
                    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-[var(--app-bg)]">
                        <Outlet />
                    </div>
                ) : null}
            </div>
            {desktopFileSidebarVisible && isDesktopFileLayout ? (
                <div className="flex w-72 shrink-0 flex-col border-l border-border-default">
                    <WorkspaceFileSidebar sessionId={sessionId} />
                </div>
            ) : null}
            <MobileFileSidebar
                sessionId={sessionId}
                open={fileDrawerOpen}
                onOpenChange={setFileDrawerOpen}
            />
        </div>
    )
}

function SessionDetailRoute() {
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const basePath = `/sessions/${sessionId}`
    const isFile = pathname === `${basePath}/file`
    const activeTab: WorkspaceTabId = pathname === `${basePath}/terminal`
        ? 'terminal'
        : pathname === `${basePath}/files`
            ? 'files'
            : pathname === `${basePath}/file`
                ? 'files'
            : 'chat'
    return <SessionWorkspace sessionId={sessionId} activeTab={activeTab} showFileOverlay={isFile} />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const search = useSearch({ from: '/sessions/new' })
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()

    const { data: sourceUiState } = useQuery({
        queryKey: ['sessionUiState', search.sourceSessionId],
        queryFn: () => api.getSessionUiState(search.sourceSessionId!),
        enabled: !!search.sourceSessionId,
    })

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
        <div className="flex h-full min-h-0 flex-col">
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
                <div className="flex-1 font-semibold">{t('newSession.title')}</div>
            </div>

            <div
                className="app-scroll-y flex-1 min-h-0"
                style={{ paddingBottom: 'calc(var(--app-floating-bottom-offset, 0px) + env(safe-area-inset-bottom))' }}
            >
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
                    initialMachineId={search.machineId}
                    initialPath={search.path}
                    initialSystemPrompt={sourceUiState?.systemPrompt}
                    initialUseGlobalPrompt={sourceUiState?.useGlobalPrompt}
                />
            </div>
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
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories'; cwd?: string } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        const cwd = typeof search.cwd === 'string' && search.cwd.trim() ? search.cwd.trim() : undefined

        const result: { tab?: 'changes' | 'directories'; cwd?: string } = {}
        if (tab) result.tab = tab
        if (cwd) result.cwd = cwd
        return result
    },
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
    tab?: 'changes' | 'directories'
    cwd?: string
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

        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        const cwd = typeof search.cwd === 'string' && search.cwd.trim() ? search.cwd.trim() : undefined

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        if (cwd !== undefined) {
            result.cwd = cwd
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    machineId?: string
    path?: string
    sourceSessionId?: string
}

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    validateSearch: (search: Record<string, unknown>): NewSessionSearch => ({
        machineId: typeof search.machineId === 'string' ? search.machineId : undefined,
        path: typeof search.path === 'string' ? search.path : undefined,
        sourceSessionId: typeof search.sourceSessionId === 'string' ? search.sourceSessionId : undefined,
    }),
    component: NewSessionPage,
})

function SharedSessionsPageWrapper() {
    const { api } = useAppContext()
    return <SharedSessionsPage api={api} />
}

const sharedSessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/shared',
    component: SharedSessionsPageWrapper,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsLayout,
})

const settingsIndexRoute = createRoute({ getParentRoute: () => settingsRoute, path: '/', component: SettingsHome })
const settingsGeneralRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'general', component: GeneralSettings })
const settingsChatRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'chat', component: ChatSettings })
const settingsQuickPhrasesRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'chat/phrases', component: QuickPhrasesPage })
const settingsModelsRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'models', component: ModelsSettings })
const settingsProvidersRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'models/providers', component: ProvidersPage })
const settingsDevicesRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'devices', component: DevicesSettings })
const settingsMachinesRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'devices/machines', component: MachinesPage })
const settingsAddDeviceRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'devices/add', component: AddDevicePage })
const settingsSpeakersRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'devices/speakers', component: SpeakersPage })
const settingsSessionsRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'sessions', component: SessionsSettings })
const settingsAccountRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'account', component: AccountSettings })
const settingsApiKeysRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'account/keys', component: ApiKeysPage })
const settingsAboutRoute = createRoute({ getParentRoute: () => settingsRoute, path: 'about', component: AboutSettings })

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

const sharedSessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/shared/$shareToken',
    component: SharedSessionPage,
})

function GuestSessionPage() {
    const { grantId } = guestSessionRoute.useParams()
    return (
        <GuestSessionShell grantId={grantId}>
            {(sessionId) => <SessionView sessionId={sessionId} onBack={() => {}} />}
        </GuestSessionShell>
    )
}

const guestSessionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/guest/$grantId',
    component: GuestSessionPage,
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
    settingsRoute.addChildren([
        settingsIndexRoute,
        settingsGeneralRoute,
        settingsChatRoute,
        settingsQuickPhrasesRoute,
        settingsModelsRoute,
        settingsProvidersRoute,
        settingsDevicesRoute,
        settingsMachinesRoute,
        settingsAddDeviceRoute,
        settingsSpeakersRoute,
        settingsSessionsRoute,
        settingsAccountRoute,
        settingsApiKeysRoute,
        settingsAboutRoute,
    ]),
    sharedSessionsRoute,
    qrConfirmRoute,
    sharedSessionRoute,
    guestSessionRoute,
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
