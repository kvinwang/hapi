import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import type { UsageData } from '@hapi/protocol/chat'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { ArrowDownToLineIcon } from '@/components/icons'
import {
    DRAG_THRESHOLD_PX,
    loadJumpButtonPosition,
    offsetToPosition,
    positionToOffset,
    saveJumpButtonPosition,
    clearJumpButtonPosition,
    type JumpButtonPosition
} from '@/components/AssistantChat/jumpButtonPosition'
import { useTranslation } from '@/lib/use-translation'
import type { OlderMessagesFetchSummary } from '@/lib/message-window-store'
import {
    applyAnchorOffsetScrollTop,
    applyHeightDeltaScrollTop,
    contentOffsetOf,
    findFirstVisibleMessage,
    findLoadOlderAnchor,
    isWithinChatBottomThreshold,
    shouldFinishScrollSettle,
    shouldStayAtBottomOnLoadOlder
} from '@/components/AssistantChat/scroll-position'

function NewMessagesIndicator(props: { count: number; showGoLatest: boolean; isLoading: boolean; onClick: () => void }) {
    const { t } = useTranslation()
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const [position, setPosition] = useState<JumpButtonPosition | null>(() => loadJumpButtonPosition())
    const [offset, setOffset] = useState<{ left: number; top: number } | null>(null)
    const dragRef = useRef<{ pointerId: number; grabX: number; grabY: number; moved: number } | null>(null)

    const visible = props.count > 0 || props.showGoLatest

    // Place a remembered position against the chat area, and re-place it when
    // that area changes shape (rotation, a resized pane, the keyboard opening).
    useLayoutEffect(() => {
        const button = buttonRef.current
        const container = button?.offsetParent as HTMLElement | null
        if (!visible || !button || !container || !position) {
            setOffset(null)
            return
        }
        const place = () => {
            setOffset(positionToOffset(
                position,
                { width: container.clientWidth, height: container.clientHeight },
                { width: button.offsetWidth, height: button.offsetHeight }
            ))
        }
        place()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(place)
        observer.observe(container)
        return () => observer.disconnect()
    }, [position, visible, props.count])

    if (!visible) {
        return null
    }

    const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        const button = buttonRef.current
        const container = button?.offsetParent as HTMLElement | null
        if (!button || !container) return
        const rect = button.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        dragRef.current = {
            pointerId: event.pointerId,
            grabX: event.clientX - rect.left,
            grabY: event.clientY - rect.top,
            moved: 0
        }
        button.setPointerCapture(event.pointerId)
        // Anchor to the current spot so the first move does not jump.
        setOffset({ left: rect.left - containerRect.left, top: rect.top - containerRect.top })
    }

    const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current
        const button = buttonRef.current
        const container = button?.offsetParent as HTMLElement | null
        if (!drag || drag.pointerId !== event.pointerId || !button || !container) return
        const containerRect = container.getBoundingClientRect()
        const next = {
            left: event.clientX - containerRect.left - drag.grabX,
            top: event.clientY - containerRect.top - drag.grabY
        }
        drag.moved += Math.abs(event.movementX) + Math.abs(event.movementY)
        const box = { width: container.clientWidth, height: container.clientHeight }
        const size = { width: button.offsetWidth, height: button.offsetHeight }
        setOffset(positionToOffset(offsetToPosition(next, box, size), box, size))
    }

    const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current
        const button = buttonRef.current
        const container = button?.offsetParent as HTMLElement | null
        dragRef.current = null
        if (!drag || !button || !container) return
        button.releasePointerCapture?.(event.pointerId)
        if (drag.moved < DRAG_THRESHOLD_PX) {
            props.onClick()
            return
        }
        const rect = button.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        const next = offsetToPosition(
            { left: rect.left - containerRect.left, top: rect.top - containerRect.top },
            { width: container.clientWidth, height: container.clientHeight },
            { width: button.offsetWidth, height: button.offsetHeight }
        )
        setPosition(next)
        saveJumpButtonPosition(next)
    }

    // With unread messages the count is the message; without, the gesture needs
    // no words — a dot with an arrow into a line says "back to the bottom".
    const compact = props.count === 0
    const placed = offset !== null
    return (
        <button
            ref={buttonRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => { dragRef.current = null }}
            onDoubleClick={() => {
                // Back to the corner it started in.
                clearJumpButtonPosition()
                setPosition(null)
                setOffset(null)
            }}
            disabled={props.isLoading}
            aria-busy={props.isLoading}
            aria-label={t('misc.goToLatest')}
            title={t('misc.goToLatest')}
            style={placed
                ? { left: offset.left, top: offset.top, touchAction: 'none' }
                : { touchAction: 'none' }}
            className={`absolute z-10 animate-bounce-in bg-[var(--app-button)] text-[var(--app-button-text)] shadow-lg disabled:opacity-70 ${
                placed ? '' : 'bottom-20 left-1/2 -translate-x-1/2'
            } ${
                compact
                    ? 'flex h-9 w-9 cursor-grab items-center justify-center rounded-full active:cursor-grabbing'
                    : 'cursor-grab rounded-full px-3 py-1.5 text-sm font-medium active:cursor-grabbing'
            }`}
        >
            {props.isLoading
                ? (compact ? <Spinner size="sm" label={null} className="text-current" /> : t('misc.loading'))
                : (compact ? <ArrowDownToLineIcon /> : t('misc.newMessage', { n: props.count }))}
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

function isOlderMessagesFetchSummary(value: unknown): value is OlderMessagesFetchSummary {
    if (!value || typeof value !== 'object') return false
    const summary = value as Record<string, unknown>
    return ['pages', 'received', 'text', 'activity', 'unrecognized']
        .every((key) => typeof summary[key] === 'number')
}

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
    contextWindowTokens?: number | null
    getUsageAtSeq?: (seq: number) => UsageData | null
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
    const [loadOlderNotice, setLoadOlderNotice] = useState(false)
    const normalizedMessagesCountRef = useRef(props.normalizedMessagesCount)
    const loadLockRef = useRef(false)
    const loadNewerLockRef = useRef(false)
    const pendingScrollRef = useRef<{
        anchor: HTMLElement | null
        anchorMessageId: string | null
        /**
         * Where the anchor sits inside the content, not inside the viewport.
         * A viewport-relative baseline goes stale the moment the reader keeps
         * scrolling: restoring it would undo every pixel they travelled while
         * the page was in flight, which is the lurch a fling makes visible.
         */
        anchorOffset: number
        scrollTop: number
        scrollHeight: number
        preserveAnchor: boolean
        stayAtBottom: boolean
        // After load-older commits, keep compensating until height stops changing.
        settleStartedAt: number | null
        stableHeightFrames: number
        lastObservedHeight: number
    } | null>(null)
    // Suppress top-sentinel auto-load until the first open/bottom pin settles.
    // Otherwise the first paint at scrollTop=0 can load-older and disable
    // follow-bottom before the initial pin runs, leaving the session near the top.
    const allowAutoLoadOlderRef = useRef(false)
    const initialBottomPinFrameRef = useRef<number | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const pendingAnchorSettleFrameRef = useRef<number | null>(null)
    const mutationSettleFrameRef = useRef<number | null>(null)
    const pendingLoadPromiseRef = useRef<Promise<boolean> | null>(null)
    const pendingLoadResolveRef = useRef<((value: boolean) => void) | null>(null)
    const pendingLoadBaselineRef = useRef<{ messagesVersion: number; hasMoreMessages: boolean } | null>(null)
    const lastOlderFetchRef = useRef<OlderMessagesFetchSummary | null>(null)
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
            const scrollingUp = nextScrollTop < lastScrollTopRef.current
            lastScrollTopRef.current = nextScrollTop
            if (scrollingUp) {
                allowAutoLoadOlderRef.current = true
            }
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
                allowAutoLoadOlderRef.current = true
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
                allowAutoLoadOlderRef.current = true
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
                allowAutoLoadOlderRef.current = true
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
        if (!pending || !viewport) return
        if (pending.stayAtBottom) {
            viewport.scrollTop = viewport.scrollHeight
            followBottomRef.current = true
            if (!atBottomRef.current) {
                atBottomRef.current = true
                setIsAtBottom(true)
                onAtBottomChangeRef.current(true)
            }
            pending.scrollTop = viewport.scrollTop
            pending.scrollHeight = viewport.scrollHeight
            pending.lastObservedHeight = viewport.scrollHeight
            return
        }
        if (!pending.preserveAnchor) return

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

        // Prefer the visible message anchor. Always refresh baselines so later
        // height-delta restores do not re-apply growth that was already handled.
        if (anchor && messageContainer) {
            pending.anchor = anchor
            const nextOffset = contentOffsetOf(anchor, messageContainer)
            viewport.scrollTop = applyAnchorOffsetScrollTop(
                viewport.scrollTop,
                pending.anchorOffset,
                nextOffset
            )
            pending.anchorOffset = nextOffset
        } else {
            // No anchor to hold: shift by however much the content grew since the
            // last look, measured from where the reader is now rather than from
            // where they were when the request went out.
            viewport.scrollTop = applyHeightDeltaScrollTop(
                viewport.scrollTop,
                pending.lastObservedHeight,
                viewport.scrollHeight
            )
        }
        pending.scrollTop = viewport.scrollTop
        pending.scrollHeight = viewport.scrollHeight
        pending.lastObservedHeight = viewport.scrollHeight
    }, [])

    const mutatePreservingScroll = useCallback((mutate: () => void, source?: HTMLElement) => {
        const viewport = viewportRef.current
        const messageContainer = contentRef.current?.querySelector<HTMLElement>('.happy-thread-messages') ?? null
        if (!viewport || !messageContainer || pendingScrollRef.current) {
            mutate()
            return
        }
        const viewportTop = viewport.getBoundingClientRect().top
        const mutationIsAboveViewport = source
            ? source.getBoundingClientRect().bottom < viewportTop
            : false
        const anchor = mutationIsAboveViewport
            ? null
            : findFirstVisibleMessage(messageContainer.children, viewportTop)
        pendingScrollRef.current = {
            anchor,
            anchorMessageId: anchor?.dataset.happyMessageId ?? null,
            anchorOffset: anchor ? contentOffsetOf(anchor, messageContainer) : 0,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            preserveAnchor: true,
            stayAtBottom: false,
            settleStartedAt: null,
            stableHeightFrames: 0,
            lastObservedHeight: viewport.scrollHeight
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
        if (initialBottomPinFrameRef.current !== null) {
            cancelAnimationFrame(initialBottomPinFrameRef.current)
            initialBottomPinFrameRef.current = null
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

        // The message list renders from its own store, so its commit never runs
        // this component's layout effects. A ResizeObserver only reports a frame
        // later, and that frame paints the older page already inserted with the
        // scroll offset not yet moved — the jump. Mutation records arrive as a
        // microtask right after the DOM changes, still before paint.
        let mutations: MutationObserver | null = null
        if (typeof MutationObserver !== 'undefined') {
            mutations = new MutationObserver(() => {
                if (pendingScrollRef.current?.preserveAnchor) {
                    restorePendingAnchor()
                }
            })
            mutations.observe(content, { childList: true, subtree: true })
        }

        return () => {
            observer.disconnect()
            mutations?.disconnect()
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
        allowAutoLoadOlderRef.current = false
        if (initialBottomPinFrameRef.current !== null) {
            cancelAnimationFrame(initialBottomPinFrameRef.current)
            initialBottomPinFrameRef.current = null
        }
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

    const clearPendingScroll = useCallback((result: boolean) => {
        if (pendingAnchorSettleFrameRef.current !== null) {
            cancelAnimationFrame(pendingAnchorSettleFrameRef.current)
            pendingAnchorSettleFrameRef.current = null
        }
        pendingScrollRef.current = null
        loadLockRef.current = false
        settlePendingLoad(result)
    }, [settlePendingLoad])

    // Prepended content (and async layout: shiki, images, tool rows) can keep
    // changing height for several frames after React commits. Hold the anchor
    // until height is stable so "load older" does not visibly jump.
    const schedulePendingScrollSettle = useCallback((result: boolean) => {
        const pending = pendingScrollRef.current
        if (!pending) {
            settlePendingLoad(result)
            return
        }
        if (pending.stayAtBottom || !pending.preserveAnchor) {
            restorePendingAnchor()
            clearPendingScroll(result)
            return
        }

        pending.settleStartedAt = Date.now()
        pending.stableHeightFrames = 0
        // Do not re-baseline the height here. When the load resolves in the same
        // commit that inserts the older page, adopting the post-prepend height
        // would make the first restore a no-op and the page would jump by the
        // whole prepend. restorePendingAnchor refreshes the baseline itself once
        // it has compensated.
        restorePendingAnchor()

        if (pendingAnchorSettleFrameRef.current !== null) {
            cancelAnimationFrame(pendingAnchorSettleFrameRef.current)
        }

        const tick = () => {
            const active = pendingScrollRef.current
            if (!active) {
                pendingAnchorSettleFrameRef.current = null
                settlePendingLoad(result)
                return
            }
            if (!active.preserveAnchor || active.stayAtBottom) {
                restorePendingAnchor()
                clearPendingScroll(result)
                return
            }

            const nextViewport = viewportRef.current
            const height = nextViewport?.scrollHeight ?? active.lastObservedHeight
            if (height === active.lastObservedHeight) {
                active.stableHeightFrames += 1
            } else {
                active.stableHeightFrames = 0
            }
            // Leave the height baseline to restorePendingAnchor: adopting the new
            // height here would tell it nothing had grown.
            restorePendingAnchor()

            const elapsedMs = Date.now() - (active.settleStartedAt ?? Date.now())
            if (shouldFinishScrollSettle({
                stableHeightFrames: active.stableHeightFrames,
                elapsedMs
            })) {
                clearPendingScroll(result)
                return
            }
            pendingAnchorSettleFrameRef.current = requestAnimationFrame(tick)
        }
        pendingAnchorSettleFrameRef.current = requestAnimationFrame(tick)
    }, [clearPendingScroll, restorePendingAnchor, settlePendingLoad])

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
        const stayAtBottom = shouldStayAtBottomOnLoadOlder(followBottomRef.current, atBottomRef.current)
        const anchor = (!stayAtBottom && messageContainer)
            ? findLoadOlderAnchor(messageContainer.children, viewportTop)
            : null
        pendingScrollRef.current = {
            anchor,
            anchorMessageId: anchor?.dataset.happyMessageId ?? null,
            anchorOffset: (anchor && messageContainer) ? contentOffsetOf(anchor, messageContainer) : 0,
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            preserveAnchor: !stayAtBottom,
            stayAtBottom,
            settleStartedAt: null,
            stableHeightFrames: 0,
            lastObservedHeight: viewport.scrollHeight
        }
        if (!stayAtBottom) {
            followBottomRef.current = false
        }
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
                    schedulePendingScrollSettle(result)
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
            void onLoadMoreRef.current().then((summary) => {
                lastOlderFetchRef.current = isOlderMessagesFetchSummary(summary) ? summary : null
            }).catch((error) => {
                console.error('Failed to load older messages:', error)
                scheduleCleanup(false)
            }).finally(() => {
                if (!isLoadingMoreRef.current) {
                    scheduleCleanup(true)
                }
            })
        } catch (error) {
            clearPendingScroll(false)
            console.error('Failed to load older messages:', error)
        }
        return loadPromise
    }, [clearPendingScroll, schedulePendingScrollSettle, settlePendingLoad])

    const handleLoadMore = useCallback(() => {
        void loadOlderPreservingScroll()
    }, [loadOlderPreservingScroll])

    const handleManualLoadMore = useCallback(async () => {
        const countBeforeLoad = normalizedMessagesCountRef.current
        await loadOlderPreservingScroll()
        setLoadOlderNotice(normalizedMessagesCountRef.current === countBeforeLoad)
    }, [loadOlderPreservingScroll])

    useEffect(() => {
        normalizedMessagesCountRef.current = props.normalizedMessagesCount
    }, [props.normalizedMessagesCount])

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
                    if (entry.isIntersecting && allowAutoLoadOlderRef.current) {
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

    // Every commit while a load is in flight, before the browser paints. The
    // rAF-driven settle passes run a frame later, which is one painted frame
    // with the older page already inserted and the scroll offset not yet moved
    // — the flash the reader sees as a jump.
    useLayoutEffect(() => {
        if (pendingScrollRef.current?.preserveAnchor) {
            restorePendingAnchor()
        }
    })

    useLayoutEffect(() => {
        if (pendingScrollRef.current) {
            restorePendingAnchor()
            return
        }
        if (!followBottomRef.current) {
            return
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        viewport.scrollTop = viewport.scrollHeight
        if (props.isLoadingMessages) {
            return
        }
        // Re-pin across a couple frames while message/tool layout settles, then
        // arm top-sentinel auto-load. This closes the open-session race where
        // the first paint is near the top before estimated heights resolve.
        if (initialBottomPinFrameRef.current !== null) {
            cancelAnimationFrame(initialBottomPinFrameRef.current)
        }
        initialBottomPinFrameRef.current = requestAnimationFrame(() => {
            if (followBottomRef.current && viewportRef.current) {
                viewportRef.current.scrollTop = viewportRef.current.scrollHeight
            }
            initialBottomPinFrameRef.current = requestAnimationFrame(() => {
                if (followBottomRef.current && viewportRef.current) {
                    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
                }
                initialBottomPinFrameRef.current = null
                allowAutoLoadOlderRef.current = true
            })
        })
    }, [props.isLoadingMessages, props.messagesVersion, restorePendingAnchor])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        if (prevLoadingMoreRef.current && !props.isLoadingMoreMessages) {
            schedulePendingScrollSettle(true)
        }
        prevLoadingMoreRef.current = props.isLoadingMoreMessages
        return () => {
            if (pendingAnchorSettleFrameRef.current !== null) {
                cancelAnimationFrame(pendingAnchorSettleFrameRef.current)
                pendingAnchorSettleFrameRef.current = null
            }
        }
    }, [props.isLoadingMoreMessages, schedulePendingScrollSettle])

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
                                        onClick={() => {
                                            allowAutoLoadOlderRef.current = true
                                            void handleManualLoadMore()
                                        }}
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

                        {loadOlderNotice ? (
                            <p className="mx-auto mb-2 max-w-72 text-center text-xs text-[var(--app-hint)]" role="status">
                                            {lastOlderFetchRef.current
                                                ? t('misc.loadOlderNoChange', lastOlderFetchRef.current)
                                                : t('misc.loadOlderNoResult')}
                            </p>
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
        contextWindowTokens: props.contextWindowTokens,
        getUsageAtSeq: props.getUsageAtSeq,
        staticView: props.staticView ?? false,
        trimMode: props.trimMode ?? false,
        onTrim: props.onTrim,
        mutatePreservingScroll
    }), [
        mutatePreservingScroll,
        props.api,
        props.disabled,
        props.maxBlockSeq,
        props.contextWindowTokens,
        props.getUsageAtSeq,
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
