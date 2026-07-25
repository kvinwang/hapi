import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { findFirstVisibleMessage, isWithinChatBottomThreshold } from '@/components/AssistantChat/scroll-position'

function NewMessagesIndicator(props: { count: number; showGoLatest: boolean; isLoading: boolean; onClick: () => void }) {
    const { t } = useTranslation()
    if (props.count === 0 && !props.showGoLatest) {
        return null
    }

    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-10 flex justify-center">
            <button
                onClick={props.onClick}
                disabled={props.isLoading}
                aria-busy={props.isLoading}
                className="pointer-events-auto bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 rounded-full text-sm font-medium shadow-lg animate-bounce-in disabled:opacity-70"
            >
                {props.isLoading ? t('misc.loading') : (props.count > 0 ? t('misc.newMessage', { n: props.count }) : `${t('misc.goToLatest')} ↓`)}
            </button>
        </div>
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
    onForkFullHistory?: (messageSeq: number) => void
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
    staticView?: boolean
    trimMode?: boolean
    onTrim?: (action: { mode: 'before' | 'after' | 'single'; seq: number }) => void
}) {
    const { t } = useTranslation()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const bottomSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const loadNewerLockRef = useRef(false)
    const pendingScrollRef = useRef<{
        anchor: HTMLElement | null
        anchorMessageId: string | null
        anchorOffset: number
        scrollTop: number
        scrollHeight: number
        preserveAnchor: boolean
    } | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const pendingAnchorSettleFrameRef = useRef<number | null>(null)
    const mutationSettleFrameRef = useRef<number | null>(null)
    const pendingLoadPromiseRef = useRef<Promise<boolean> | null>(null)
    const pendingLoadResolveRef = useRef<((value: boolean) => void) | null>(null)
    const pendingLoadBaselineRef = useRef<{ messagesVersion: number; hasMoreMessages: boolean } | null>(null)
    const messagesVersionRef = useRef(props.messagesVersion)
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
    const pointerActiveRef = useRef(false)
    const lastScrollTopRef = useRef(0)
    const goLatestLockRef = useRef(false)
    const pendingGoLatestRef = useRef<{ messagesVersion: number; hasMoreNewerMessages: boolean } | null>(null)
    const [isGoingLatest, setIsGoingLatest] = useState(false)

    // This is the only source of truth for automatic scrolling. assistant-ui's
    // viewport auto-scroll is disabled below so it cannot race this controller.
    const followBottomRef = useRef(props.initialAutoScroll ?? true)
    const [isAtBottom, setIsAtBottom] = useState(true)

    // Keep refs in sync with state
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
        messagesVersionRef.current = props.messagesVersion
    }, [props.messagesVersion])
    useEffect(() => {
        hasMoreNewerMessagesRef.current = props.hasMoreNewerMessages
    }, [props.hasMoreNewerMessages])
    useEffect(() => {
        if (!props.hasMoreNewerMessages && atBottomRef.current) {
            followBottomRef.current = true
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

        lastScrollTopRef.current = viewport.scrollTop

        const handleScroll = () => {
            const nextScrollTop = viewport.scrollTop
            const scrollingDown = nextScrollTop > lastScrollTopRef.current
            lastScrollTopRef.current = nextScrollTop
            if (scrollingDown && pointerActiveRef.current && pendingScrollRef.current) {
                pendingScrollRef.current.preserveAnchor = false
            }
            const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
            const isNearBottom = isWithinChatBottomThreshold(distanceFromBottom, atBottomRef.current)

            if (isNearBottom) {
                if (!hasMoreNewerMessagesRef.current) {
                    followBottomRef.current = true
                }
            } else if (userScrollIntentRef.current === 'up' || pointerActiveRef.current) {
                followBottomRef.current = false
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
                if (pendingScrollRef.current) pendingScrollRef.current.preserveAnchor = false
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
                if (pendingScrollRef.current) pendingScrollRef.current.preserveAnchor = false
            } else if (nextY > prevY) {
                userScrollIntentRef.current = 'up'
            }
            touchStartYRef.current = nextY
        }

        const handleTouchEnd = () => {
            touchStartYRef.current = null
        }

        const handlePointerDown = () => {
            pointerActiveRef.current = true
        }

        const handlePointerUp = () => {
            pointerActiveRef.current = false
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'End' || event.key === ' ') {
                userScrollIntentRef.current = 'down'
                if (pendingScrollRef.current) pendingScrollRef.current.preserveAnchor = false
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
        viewport.addEventListener('pointerdown', handlePointerDown, { passive: true })
        window.addEventListener('pointerup', handlePointerUp, { passive: true })
        viewport.addEventListener('keydown', handleKeyDown)
        return () => {
            viewport.removeEventListener('scroll', handleScroll)
            viewport.removeEventListener('wheel', handleWheel)
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('pointerdown', handlePointerDown)
            window.removeEventListener('pointerup', handlePointerUp)
            viewport.removeEventListener('keydown', handleKeyDown)
        }
    }, []) // Stable: no dependencies, reads from refs

    const restorePendingAnchor = useCallback(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!pending || !pending.preserveAnchor || !viewport) return
        const messageContainer = contentRef.current?.querySelector<HTMLElement>('.happy-thread-messages') ?? null
        const stableAnchor = pending.anchorMessageId && messageContainer
            ? Array.from(messageContainer.children).find((child) => (
                child instanceof HTMLElement
                && child.dataset.happyMessageId === pending.anchorMessageId
            )) as HTMLElement | undefined
            : undefined
        const anchor = stableAnchor ?? (
            pending.anchor?.isConnected
            && pending.anchor.dataset.happyMessageId === pending.anchorMessageId
                ? pending.anchor
                : null
        )
        if (anchor) {
            pending.anchor = anchor
            const viewportTop = viewport.getBoundingClientRect().top
            const nextOffset = anchor.getBoundingClientRect().top - viewportTop
            viewport.scrollTop += nextOffset - pending.anchorOffset
            return
        }
        const delta = viewport.scrollHeight - pending.scrollHeight
        viewport.scrollTop = pending.scrollTop + delta
        pending.scrollTop = viewport.scrollTop
        pending.scrollHeight = viewport.scrollHeight
    }, [])

    const mutatePreservingScroll = useCallback((mutate: () => void) => {
        const viewport = viewportRef.current
        const messageContainer = contentRef.current?.querySelector<HTMLElement>('.happy-thread-messages') ?? null
        if (!viewport || !messageContainer || pendingScrollRef.current) {
            mutate()
            return
        }
        const viewportTop = viewport.getBoundingClientRect().top
        const anchor = findFirstVisibleMessage(messageContainer.children, viewportTop)
        pendingScrollRef.current = {
            anchor,
            anchorMessageId: anchor?.dataset.happyMessageId ?? null,
            anchorOffset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            preserveAnchor: true
        }
        mutate()
        if (mutationSettleFrameRef.current !== null) {
            cancelAnimationFrame(mutationSettleFrameRef.current)
        }
        mutationSettleFrameRef.current = requestAnimationFrame(() => {
            restorePendingAnchor()
            mutationSettleFrameRef.current = requestAnimationFrame(() => {
                restorePendingAnchor()
                mutationSettleFrameRef.current = null
                pendingScrollRef.current = null
            })
        })
    }, [restorePendingAnchor])

    useEffect(() => () => {
        if (mutationSettleFrameRef.current !== null) {
            cancelAnimationFrame(mutationSettleFrameRef.current)
        }
    }, [])

    // Handle every source of content height changes in one place. During a
    // multi-page prepend the original visible message remains the anchor across
    // every intermediate render. Otherwise only a viewport explicitly pinned
    // to the live tail follows streaming/expanding content.
    useEffect(() => {
        const viewport = viewportRef.current
        const content = contentRef.current
        if (!viewport || !content || typeof ResizeObserver === 'undefined') return

        let frame: number | null = null
        const observer = new ResizeObserver(() => {
            if (frame !== null) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                frame = null
                if (pendingScrollRef.current) {
                    restorePendingAnchor()
                } else if (followBottomRef.current) {
                    viewport.scrollTop = viewport.scrollHeight
                }
            })
        })
        observer.observe(content)
        return () => {
            observer.disconnect()
            if (frame !== null) cancelAnimationFrame(frame)
        }
    }, [props.sessionId, restorePendingAnchor])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        userScrollIntentRef.current = null
        pointerActiveRef.current = false
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
        }
        followBottomRef.current = true
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
        followBottomRef.current = true
        autoLoadNewerArmedRef.current = false
        userScrollIntentRef.current = null

        void (async () => {
            try {
                const baseline = {
                    messagesVersion: messagesVersionRef.current,
                    hasMoreNewerMessages: hasMoreNewerMessagesRef.current
                }
                await props.onGoToLatest()
                pendingGoLatestRef.current = baseline
                const viewport = viewportRef.current
                if (viewport) {
                    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' })
                }
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
        followBottomRef.current = props.initialAutoScroll ?? true
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
        pendingGoLatestRef.current = null
    }, [props.sessionId])

    // The message store notifies React asynchronously. Waiting for onGoToLatest
    // therefore does not mean the latest messages are in the DOM yet. Finish the
    // jump only after that render commits (or immediately when no page swap was
    // needed), then let the resize observer keep the live tail pinned.
    useLayoutEffect(() => {
        const pending = pendingGoLatestRef.current
        const viewport = viewportRef.current
        if (!pending || !viewport) {
            return
        }
        const pageChanged = props.messagesVersion !== pending.messagesVersion
            || props.hasMoreNewerMessages !== pending.hasMoreNewerMessages
        if (pending.hasMoreNewerMessages && !pageChanged) {
            return
        }

        viewport.scrollTop = viewport.scrollHeight
        pendingGoLatestRef.current = null
        if (!atBottomRef.current) {
            atBottomRef.current = true
            setIsAtBottom(true)
            onAtBottomChangeRef.current(true)
        }
        onFlushPendingRef.current()
    }, [props.hasMoreNewerMessages, props.messagesVersion])

    useLayoutEffect(() => {
        const token = props.suspendAutoLoadNewerToken ?? 0
        if (token === suspendAutoLoadNewerTokenRef.current) {
            return
        }
        suspendAutoLoadNewerTokenRef.current = token
        autoLoadNewerArmedRef.current = false
        userScrollIntentRef.current = null
        followBottomRef.current = false
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

    const settlePendingLoad = useCallback((result: boolean) => {
        const resolve = pendingLoadResolveRef.current
        const baseline = pendingLoadBaselineRef.current
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        pendingLoadBaselineRef.current = null
        if (!resolve) {
            return
        }
        if (!result || !baseline) {
            resolve(result)
            return
        }
        resolve(
            messagesVersionRef.current !== baseline.messagesVersion
            || hasMoreMessagesRef.current !== baseline.hasMoreMessages
        )
    }, [])

    const loadOlderPreservingScroll = useCallback((): Promise<boolean> => {
        if (pendingLoadPromiseRef.current) {
            return pendingLoadPromiseRef.current
        }
        if (
            isLoadingMessagesRef.current
            || !hasMoreMessagesRef.current
            || isLoadingMoreRef.current
            || loadLockRef.current
        ) {
            return Promise.resolve(false)
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return Promise.resolve(false)
        }
        const viewportTop = viewport.getBoundingClientRect().top
        const messageContainer = contentRef.current?.querySelector<HTMLElement>('.happy-thread-messages') ?? null
        const anchor = messageContainer
            ? findFirstVisibleMessage(messageContainer.children, viewportTop)
            : null
        pendingScrollRef.current = {
            anchor,
            anchorMessageId: anchor?.dataset.happyMessageId ?? null,
            anchorOffset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            preserveAnchor: true
        }
        followBottomRef.current = false
        loadLockRef.current = true
        pendingLoadBaselineRef.current = {
            messagesVersion: messagesVersionRef.current,
            hasMoreMessages: hasMoreMessagesRef.current
        }
        const loadPromise = new Promise<boolean>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        // Store notifications are throttled (see message-window-store), so a fast
        // fetch can finish before React ever renders isLoadingMore=true. Clearing
        // the pending anchor at promise resolution would then drop scroll
        // compensation for the prepended render and the viewport would jump by
        // the full prepended height. Instead, wait until the prepend actually
        // lands (messagesVersion changes — the layout effect restores the anchor
        // at that commit) or a generous timeout, then clean up. When React did
        // observe the loading transition, the isLoadingMore effect below owns
        // cleanup instead.
        const scheduleCleanup = (result: boolean) => {
            const baseline = pendingLoadBaselineRef.current
            const startedAt = Date.now()
            const check = () => {
                if (isLoadingMoreRef.current) {
                    // React observed the loading state; the transition effect
                    // (prevLoadingMoreRef) performs the final restore + cleanup.
                    return
                }
                const landed = baseline !== null
                    && messagesVersionRef.current !== baseline.messagesVersion
                if (pendingScrollRef.current && (landed || Date.now() - startedAt > 1000)) {
                    restorePendingAnchor()
                    pendingScrollRef.current = null
                    loadLockRef.current = false
                    settlePendingLoad(result)
                    return
                }
                if (!pendingScrollRef.current) {
                    settlePendingLoad(result)
                    return
                }
                setTimeout(check, 50)
            }
            setTimeout(check, 0)
        }
        try {
            void onLoadMoreRef.current().catch((error) => {
                console.error('Failed to load older messages:', error)
                scheduleCleanup(false)
            }).finally(() => {
                if (!isLoadingMoreRef.current) {
                    scheduleCleanup(true)
                }
            })
        } catch (error) {
            pendingScrollRef.current = null
            loadLockRef.current = false
            settlePendingLoad(false)
            console.error('Failed to load older messages:', error)
        }
        return loadPromise
    }, [settlePendingLoad])

    const handleLoadMore = useCallback(() => {
        void loadOlderPreservingScroll()
    }, [loadOlderPreservingScroll])

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
        if (pendingScrollRef.current) {
            restorePendingAnchor()
        } else if (followBottomRef.current) {
            const viewport = viewportRef.current
            if (viewport) viewport.scrollTop = viewport.scrollHeight
        }
    }, [props.messagesVersion, restorePendingAnchor])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages) {
            if (pendingAnchorSettleFrameRef.current !== null) {
                cancelAnimationFrame(pendingAnchorSettleFrameRef.current)
            }
            pendingAnchorSettleFrameRef.current = requestAnimationFrame(() => {
                restorePendingAnchor()
                pendingAnchorSettleFrameRef.current = requestAnimationFrame(() => {
                    restorePendingAnchor()
                    pendingAnchorSettleFrameRef.current = null
                    pendingScrollRef.current = null
                    loadLockRef.current = false
                    settlePendingLoad(true)
                })
            })
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
        return () => {
            if (pendingAnchorSettleFrameRef.current !== null) {
                cancelAnimationFrame(pendingAnchorSettleFrameRef.current)
                pendingAnchorSettleFrameRef.current = null
            }
        }
    }, [props.isLoadingMoreMessages, restorePendingAnchor, settlePendingLoad])

    useEffect(() => {
        isLoadingNewerRef.current = props.isLoadingNewerMessages
        if (!props.isLoadingNewerMessages) {
            loadNewerLockRef.current = false
        }
    }, [props.isLoadingNewerMessages])

    const showSkeleton = props.isLoadingMessages && props.rawMessagesCount === 0 && props.pendingCount === 0

    const innerContent = (
        <div ref={viewportRef} className="chat-viewport app-scroll-y min-h-0 flex-1 overflow-x-hidden">
            <div ref={contentRef} className="chat-content w-full min-w-0 max-w-[100vw] p-3">
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
                <div className="happy-thread-messages flex flex-col gap-3">
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

    const viewportContent = (
        <ThreadPrimitive.Viewport
            asChild
            autoScroll={false}
            scrollToBottomOnInitialize={false}
            scrollToBottomOnRunStart={false}
            scrollToBottomOnThreadSwitch={false}
        >
            {innerContent}
        </ThreadPrimitive.Viewport>
    )

    const showNewMessagesIndicator = props.showNewMessagesIndicator ?? true
    const chatContextValue = useMemo(() => ({
        api: props.api,
        sessionId: props.sessionId,
        metadata: props.metadata,
        disabled: props.disabled,
        onRefresh: props.onRefresh,
        onRetryMessage: props.onRetryMessage,
        onForkFromMessage: props.onForkFromMessage,
        onForkFullHistory: props.onForkFullHistory,
        maxBlockSeq: props.maxBlockSeq,
        staticView: props.staticView ?? false,
        trimMode: props.trimMode ?? false,
        onTrim: props.onTrim,
        hasMoreMessages: props.hasMoreMessages,
        isLoadingMoreMessages: props.isLoadingMoreMessages,
        loadOlderMessagesPreservingScroll: loadOlderPreservingScroll,
        mutatePreservingScroll
    }), [
        loadOlderPreservingScroll,
        mutatePreservingScroll,
        props.api,
        props.disabled,
        props.hasMoreMessages,
        props.isLoadingMoreMessages,
        props.maxBlockSeq,
        props.metadata,
        props.onForkFromMessage,
        props.onForkFullHistory,
        props.onRefresh,
        props.onRetryMessage,
        props.onTrim,
        props.sessionId,
        props.staticView,
        props.trimMode
    ])

    return (
        <HappyChatProvider value={chatContextValue}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
                {viewportContent}
                {showNewMessagesIndicator ? (
                    <NewMessagesIndicator count={props.pendingCount} showGoLatest={!isAtBottom} isLoading={isGoingLatest} onClick={goToLatest} />
                ) : null}
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
