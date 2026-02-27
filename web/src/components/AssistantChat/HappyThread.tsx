import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function NewMessagesIndicator(props: { count: number; showGoLatest: boolean; isLoading: boolean; onClick: () => void }) {
    const { t } = useTranslation()
    if (props.count === 0 && !props.showGoLatest) {
        return null
    }

    return (
        <button
            onClick={props.onClick}
            disabled={props.isLoading}
            aria-busy={props.isLoading}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in z-10 disabled:opacity-70"
        >
            {props.isLoading ? t('misc.loading') : (props.count > 0 ? t('misc.newMessage', { n: props.count }) : `${t('misc.goToLatest')} ↓`)}
        </button>
    )
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{t('misc.loadingMessages')}</span>
            <div className="space-y-3 animate-pulse">
                {rows.map((row, index) => (
                    <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}>
                        <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                    </div>
                ))}
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

export function HappyThread(props: {
    api: ApiClient | null
    sessionId: string
    metadata: SessionMetadataSummary | null
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onForkFromMessage?: (messageSeq: number) => void
    maxBlockSeq?: number
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    isLoadingMessages: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    hasMoreNewerMessages: boolean
    isLoadingMoreMessages: boolean
    isLoadingNewerMessages: boolean
    onLoadMore: () => Promise<unknown>
    onLoadNewer: () => Promise<unknown>
    onGoToLatest: () => Promise<unknown>
    pendingCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    forceScrollToken: number
    suspendAutoLoadNewerToken?: number
    footer?: ReactNode
    initialAutoScroll?: boolean
    showNewMessagesIndicator?: boolean
}) {
    const { t } = useTranslation()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const bottomSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const loadNewerLockRef = useRef(false)
    const pendingScrollRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const loadStartedRef = useRef(false)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const isLoadingNewerRef = useRef(props.isLoadingNewerMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const hasMoreNewerMessagesRef = useRef(props.hasMoreNewerMessages)
    const isLoadingMessagesRef = useRef(props.isLoadingMessages)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onLoadNewerRef = useRef(props.onLoadNewer)
    const handleLoadMoreRef = useRef<() => void>(() => {})
    const handleLoadNewerRef = useRef<() => void>(() => {})
    const atBottomRef = useRef(true)
    const onAtBottomChangeRef = useRef(props.onAtBottomChange)
    const onFlushPendingRef = useRef(props.onFlushPending)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const suspendAutoLoadNewerTokenRef = useRef(props.suspendAutoLoadNewerToken ?? 0)
    const autoLoadNewerArmedRef = useRef(false)
    const userScrollIntentRef = useRef<'up' | 'down' | null>(null)
    const touchStartYRef = useRef<number | null>(null)
    const lastScrollTopRef = useRef(0)
    const goLatestLockRef = useRef(false)
    const [isGoingLatest, setIsGoingLatest] = useState(false)

    // Smart scroll state: autoScroll enabled when user is near bottom
    const [autoScrollEnabled, setAutoScrollEnabled] = useState(props.initialAutoScroll ?? true)
    const [isAtBottom, setIsAtBottom] = useState(true)
    const autoScrollEnabledRef = useRef(autoScrollEnabled)

    // Keep refs in sync with state
    useEffect(() => {
        autoScrollEnabledRef.current = autoScrollEnabled
    }, [autoScrollEnabled])
    useEffect(() => {
        onAtBottomChangeRef.current = props.onAtBottomChange
    }, [props.onAtBottomChange])
    useEffect(() => {
        onFlushPendingRef.current = props.onFlushPending
    }, [props.onFlushPending])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        hasMoreNewerMessagesRef.current = props.hasMoreNewerMessages
    }, [props.hasMoreNewerMessages])
    useEffect(() => {
        if (!props.hasMoreNewerMessages && atBottomRef.current && !autoScrollEnabledRef.current) {
            setAutoScrollEnabled(true)
        }
        if (!props.hasMoreNewerMessages) {
            autoLoadNewerArmedRef.current = false
            userScrollIntentRef.current = null
        }
    }, [props.hasMoreNewerMessages])
    useEffect(() => {
        isLoadingMessagesRef.current = props.isLoadingMessages
    }, [props.isLoadingMessages])
    useEffect(() => {
        isLoadingNewerRef.current = props.isLoadingNewerMessages
    }, [props.isLoadingNewerMessages])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        onLoadNewerRef.current = props.onLoadNewer
    }, [props.onLoadNewer])

    // Track scroll position to toggle autoScroll (stable listener using refs)
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        const THRESHOLD_PX = 120
        lastScrollTopRef.current = viewport.scrollTop

        const handleScroll = () => {
            const nextScrollTop = viewport.scrollTop
            const scrollingDown = nextScrollTop > lastScrollTopRef.current
            lastScrollTopRef.current = nextScrollTop
            const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            const isNearBottom = distanceFromBottom < THRESHOLD_PX

            if (isNearBottom) {
                if (!hasMoreNewerMessagesRef.current && !autoScrollEnabledRef.current) {
                    setAutoScrollEnabled(true)
                }
            } else if (autoScrollEnabledRef.current) {
                setAutoScrollEnabled(false)
            }

            if (isNearBottom !== atBottomRef.current) {
                atBottomRef.current = isNearBottom
                setIsAtBottom(isNearBottom)
                onAtBottomChangeRef.current(isNearBottom)
                if (isNearBottom) {
                    onFlushPendingRef.current()
                }
            }

            if (isNearBottom) {
                if (!autoLoadNewerArmedRef.current && scrollingDown && userScrollIntentRef.current === 'down') {
                    autoLoadNewerArmedRef.current = true
                    userScrollIntentRef.current = null
                }
                handleLoadNewerRef.current()
            }
        }

        const handleWheel = (event: WheelEvent) => {
            if (event.deltaY > 0) {
                userScrollIntentRef.current = 'down'
            } else if (event.deltaY < 0) {
                userScrollIntentRef.current = 'up'
            }
        }

        const handleTouchStart = (event: TouchEvent) => {
            touchStartYRef.current = event.touches[0]?.clientY ?? null
        }

        const handleTouchMove = (event: TouchEvent) => {
            const nextY = event.touches[0]?.clientY
            const prevY = touchStartYRef.current
            if (typeof nextY !== 'number' || typeof prevY !== 'number') {
                return
            }
            if (nextY < prevY) {
                userScrollIntentRef.current = 'down'
            } else if (nextY > prevY) {
                userScrollIntentRef.current = 'up'
            }
            touchStartYRef.current = nextY
        }

        const handleTouchEnd = () => {
            touchStartYRef.current = null
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End' || event.key === ' ') {
                userScrollIntentRef.current = 'down'
                return
            }
            if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
                userScrollIntentRef.current = 'up'
            }
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        viewport.addEventListener('wheel', handleWheel, { passive: true })
        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: true })
        viewport.addEventListener('touchend', handleTouchEnd, { passive: true })
        viewport.addEventListener('keydown', handleKeyDown)
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('keydown', handleKeyDown)
        }
    }, []) // Stable: no dependencies, reads from refs

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
        setAutoScrollEnabled(true)
        if (!atBottomRef.current) {
            atBottomRef.current = true
            setIsAtBottom(true)
            onAtBottomChangeRef.current(true)
        }
        onFlushPendingRef.current()
    }, [])

    const goToLatest = useCallback(() => {
        if (goLatestLockRef.current) {
            return
        }
        goLatestLockRef.current = true
        setIsGoingLatest(true)
        setAutoScrollEnabled(true)
        autoLoadNewerArmedRef.current = false
        userScrollIntentRef.current = null

        void (async () => {
            try {
                await props.onGoToLatest()
                const viewport = viewportRef.current
                if (viewport) {
                    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' })
                }
                if (!atBottomRef.current) {
                    atBottomRef.current = true
                    setIsAtBottom(true)
                    onAtBottomChangeRef.current(true)
                }
                onFlushPendingRef.current()
            } catch (error) {
                console.error('Failed to go to latest messages:', error)
            } finally {
                goLatestLockRef.current = false
                setIsGoingLatest(false)
            }
        })()
    }, [props.onGoToLatest])

    // Reset state when session changes
    useEffect(() => {
        setAutoScrollEnabled(true)
        atBottomRef.current = true
        setIsAtBottom(true)
        onAtBottomChangeRef.current(true)
        forceScrollTokenRef.current = props.forceScrollToken
        loadNewerLockRef.current = false
        goLatestLockRef.current = false
        autoLoadNewerArmedRef.current = false
        userScrollIntentRef.current = null
        touchStartYRef.current = null
        lastScrollTopRef.current = 0
        suspendAutoLoadNewerTokenRef.current = props.suspendAutoLoadNewerToken ?? 0
    }, [props.sessionId])

    useLayoutEffect(() => {
        const token = props.suspendAutoLoadNewerToken ?? 0
        if (token === suspendAutoLoadNewerTokenRef.current) {
            return
        }
        suspendAutoLoadNewerTokenRef.current = token
        autoLoadNewerArmedRef.current = false
        userScrollIntentRef.current = null
        setAutoScrollEnabled(false)
        if (atBottomRef.current) {
            atBottomRef.current = false
            setIsAtBottom(false)
            onAtBottomChangeRef.current(false)
        }
    }, [props.suspendAutoLoadNewerToken])

    useEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        scrollToBottom()
    }, [props.forceScrollToken, scrollToBottom])

    const handleLoadMore = useCallback(() => {
        if (isLoadingMessagesRef.current || !hasMoreMessagesRef.current || isLoadingMoreRef.current || loadLockRef.current) {
            return
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        pendingScrollRef.current = {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight
        }
        loadLockRef.current = true
        loadStartedRef.current = false
        let loadPromise: Promise<unknown>
        try {
            loadPromise = onLoadMoreRef.current()
        } catch (error) {
            pendingScrollRef.current = null
            loadLockRef.current = false
            throw error
        }
        void loadPromise.catch((error) => {
            pendingScrollRef.current = null
            loadLockRef.current = false
            console.error('Failed to load older messages:', error)
        }).finally(() => {
            if (!loadStartedRef.current && !isLoadingMoreRef.current && pendingScrollRef.current) {
                pendingScrollRef.current = null
                loadLockRef.current = false
            }
        })
    }, [])

    useEffect(() => {
        handleLoadMoreRef.current = handleLoadMore
    }, [handleLoadMore])

    const handleLoadNewer = useCallback(() => {
        if (!autoLoadNewerArmedRef.current) {
            return
        }
        if (
            isLoadingMessagesRef.current
            || !hasMoreNewerMessagesRef.current
            || isLoadingNewerRef.current
            || loadNewerLockRef.current
        ) {
            return
        }

        loadNewerLockRef.current = true
        let loadPromise: Promise<unknown>
        try {
            loadPromise = onLoadNewerRef.current()
        } catch (error) {
            loadNewerLockRef.current = false
            throw error
        }

        void loadPromise.catch((error) => {
            loadNewerLockRef.current = false
            console.error('Failed to load newer messages:', error)
        }).finally(() => {
            if (!isLoadingNewerRef.current) {
                loadNewerLockRef.current = false
            }
        })
    }, [])

    useEffect(() => {
        handleLoadNewerRef.current = handleLoadNewer
    }, [handleLoadNewer])

    useEffect(() => {
        const sentinel = topSentinelRef.current
        const viewport = viewportRef.current
        if (!sentinel || !viewport || !props.hasMoreMessages || props.isLoadingMessages) {
            return
        }
        if (typeof IntersectionObserver === 'undefined') {
            return
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        handleLoadMoreRef.current()
                    }
                }
            },
            {
                root: viewport,
                rootMargin: '200px 0px 0px 0px'
            }
        )

        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [props.hasMoreMessages, props.isLoadingMessages])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!pending || !viewport) {
            return
        }
        const delta = viewport.scrollHeight - pending.scrollHeight
        viewport.scrollTop = pending.scrollTop + delta
        pendingScrollRef.current = null
        loadLockRef.current = false
    }, [props.messagesVersion])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (props.isLoadingMoreMessages) {
            loadStartedRef.current = true
        }
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages && pendingScrollRef.current) {
            pendingScrollRef.current = null
            loadLockRef.current = false
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
    }, [props.isLoadingMoreMessages])

    useEffect(() => {
        isLoadingNewerRef.current = props.isLoadingNewerMessages
        if (!props.isLoadingNewerMessages) {
            loadNewerLockRef.current = false
        }
    }, [props.isLoadingNewerMessages])

    const showSkeleton = props.isLoadingMessages && props.rawMessagesCount === 0 && props.pendingCount === 0

    const innerContent = (
        <div ref={viewportRef} className="chat-viewport min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <div className="chat-content w-full min-w-0 max-w-[100vw] p-3">
                <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                {showSkeleton ? (
                    <MessageSkeleton />
                ) : (
                    <>
                        {props.messagesWarning ? (
                            <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                                {props.messagesWarning}
                            </div>
                        ) : null}

                        {props.hasMoreMessages && !props.isLoadingMessages ? (
                            <div className="py-1 mb-2">
                                <div className="mx-auto w-fit">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleLoadMore}
                                        disabled={props.isLoadingMoreMessages || props.isLoadingMessages}
                                        aria-busy={props.isLoadingMoreMessages}
                                        className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                                    >
                                        {props.isLoadingMoreMessages ? (
                                            <>
                                                <Spinner size="sm" label={null} className="text-current" />
                                                {t('misc.loading')}
                                            </>
                                        ) : (
                                            <>
                                                <span aria-hidden="true">↑</span>
                                                {t('misc.loadOlder')}
                                            </>
                                        )}
                                    </Button>
                                </div>
                            </div>
                        ) : null}

                        {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                            <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                            </div>
                        ) : null}
                    </>
                )}
                <div className="flex flex-col gap-3">
                    <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                </div>
                <div ref={bottomSentinelRef} className="h-px w-full" aria-hidden="true" />
                {props.hasMoreNewerMessages && !props.isLoadingMessages ? (
                    <div className="py-2 mt-1">
                        <div className="mx-auto w-fit">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    autoLoadNewerArmedRef.current = true
                                    handleLoadNewer()
                                }}
                                disabled={props.isLoadingNewerMessages || props.isLoadingMessages}
                                aria-busy={props.isLoadingNewerMessages}
                                className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                            >
                                {props.isLoadingNewerMessages ? (
                                    <>
                                        <Spinner size="sm" label={null} className="text-current" />
                                        {t('misc.loading')}
                                    </>
                                ) : (
                                    <>
                                        <span aria-hidden="true">↓</span>
                                        {t('misc.loadNewer')}
                                    </>
                                )}
                            </Button>
                        </div>
                    </div>
                ) : null}
                {props.footer ?? null}
            </div>
        </div>
    )

    // When autoScroll is disabled from the start (e.g. shared page), skip
    // ThreadPrimitive.Viewport entirely so the library never scrolls to bottom.
    const viewportContent = props.initialAutoScroll === false
        ? innerContent
        : (
            <ThreadPrimitive.Viewport asChild autoScroll={autoScrollEnabled}>
                {innerContent}
            </ThreadPrimitive.Viewport>
        )

    const showNewMessagesIndicator = props.showNewMessagesIndicator ?? true

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage,
            onForkFromMessage: props.onForkFromMessage,
            maxBlockSeq: props.maxBlockSeq
        }}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                {viewportContent}
                {showNewMessagesIndicator ? (
                    <NewMessagesIndicator count={props.pendingCount} showGoLatest={!isAtBottom} isLoading={isGoingLatest} onClick={goToLatest} />
                ) : null}
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
