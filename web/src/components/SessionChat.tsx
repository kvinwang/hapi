import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, ModelMode, PermissionMode, Session } from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { buildUserMessageDomId } from '@/components/AssistantChat/messages/domIds'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { clearMessageWindow, fetchLatestMessages } from '@/lib/message-window-store'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { SessionHeader } from '@/components/SessionHeader'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useTranslation } from '@/lib/use-translation'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'
import { useToast } from '@/lib/toast-context'

const HISTORY_FETCH_PAGE_SIZE = 200
const HISTORY_FETCH_MAX_PAGES = 2000
const JUMP_SCROLL_ATTEMPTS = 30
const USER_MESSAGE_PREVIEW_LIMIT = 180

type UserMessageItem = {
    id: string
    threadMessageId: string
    seq: number | null
    createdAt: number
    preview: string
    copyText: string
}

function buildUserMessageItem(
    message: DecryptedMessage,
    options: {
        emptyFallback: string
        attachmentsFallback: (count: number) => string
    }
): UserMessageItem | null {
    const normalized = normalizeDecryptedMessage(message)
    if (!normalized || normalized.role !== 'user') {
        return null
    }
    const content = normalized.content
    if (content.type !== 'text') {
        return null
    }

    const text = content.text
    const trimmed = text.trim()
    const attachmentCount = content.attachments?.length ?? 0
    const fallback = attachmentCount > 0
        ? options.attachmentsFallback(attachmentCount)
        : options.emptyFallback
    const base = trimmed || fallback
    const preview = base.length > USER_MESSAGE_PREVIEW_LIMIT
        ? `${base.slice(0, USER_MESSAGE_PREVIEW_LIMIT - 1)}…`
        : base

    return {
        id: message.id,
        threadMessageId: `user:${message.id}`,
        seq: message.seq,
        createdAt: message.createdAt,
        preview,
        copyText: text || base
    }
}

function sortUserMessageItems(a: UserMessageItem, b: UserMessageItem): number {
    if (typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq) {
        return a.seq - b.seq
    }
    if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt
    }
    return a.id.localeCompare(b.id)
}

function waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export function SessionChat(props: {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    hasMoreNewerMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isLoadingNewerMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    onLoadNewer: () => Promise<unknown>
    onGoToLatest: () => Promise<unknown>
    onJumpToMessage: (targetSeq: number) => Promise<boolean>
    onSend: (text: string, attachments?: AttachmentMetadata[]) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    onForkFromMessage?: (messageSeq: number) => void
    onShare?: () => void
    onUnshare?: () => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const sessionInactive = !props.session.active
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const { abortSession, switchSession, setPermissionMode, setModelMode } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor
    )
    const { addToast } = useToast()
    const { commands: slashCommands } = useSlashCommands(props.api, props.session.id, agentFlavor ?? 'claude')
    const [userPanelOpen, setUserPanelOpen] = useState(false)
    const [loadingUserHistory, setLoadingUserHistory] = useState(false)
    const [userHistoryError, setUserHistoryError] = useState<string | null>(null)
    const [jumpingMessageId, setJumpingMessageId] = useState<string | null>(null)
    const [suspendAutoLoadNewerToken, setSuspendAutoLoadNewerToken] = useState(0)
    const [historyUserMessages, setHistoryUserMessages] = useState<UserMessageItem[]>([])
    const userHistoryLoadedRef = useRef(false)
    const userHistoryRequestIdRef = useRef(0)
    const userPanelRef = useRef<HTMLDivElement | null>(null)
    const [trimMode, setTrimMode] = useState(false)

    // Voice assistant integration
    const voice = useVoiceOptional()

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => props.onSend(message),
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onSend, props.onRefresh])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (sessionId === props.session.id ? props.messages : [])
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevMessagesRef = useRef<DecryptedMessage[]>([])

    useEffect(() => {
        const prevIds = new Set(prevMessagesRef.current.map(m => m.id))
        const newMessages = props.messages.filter(m => !prevIds.has(m.id))

        if (newMessages.length > 0) {
            voiceHooks.onMessages(props.session.id, newMessages)
        }

        prevMessagesRef.current = props.messages
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            await voice.stopVoice()
        } else {
            await voice.startVoice(props.session.id)
        }
    }, [voice, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
    }, [props.session.id])

    useEffect(() => {
        userHistoryLoadedRef.current = false
        userHistoryRequestIdRef.current += 1
        setUserPanelOpen(false)
        setLoadingUserHistory(false)
        setUserHistoryError(null)
        setJumpingMessageId(null)
        setSuspendAutoLoadNewerToken(0)
        setHistoryUserMessages([])
    }, [props.session.id])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            blocksByIdRef.current.clear()
        }
        prevSessionIdRef.current = props.session.id

        const cache = normalizedCacheRef.current
        const normalized: NormalizedMessage[] = []
        const seen = new Set<string>()
        for (const message of props.messages) {
            seen.add(message.id)
            const cached = cache.get(message.id)
            if (cached && cached.source === message) {
                if (cached.normalized) normalized.push(cached.normalized)
                continue
            }
            const next = normalizeDecryptedMessage(message)
            cache.set(message.id, { source: message, normalized: next })
            if (next) normalized.push(next)
        }
        for (const id of cache.keys()) {
            if (!seen.has(id)) {
                cache.delete(id)
            }
        }
        return normalized
    }, [props.messages])

    const userMessageItemOptions = useMemo(() => ({
        emptyFallback: t('chat.userPanel.emptyMessage'),
        attachmentsFallback: (count: number) => t('chat.userPanel.attachmentsOnly', { count })
    }), [t])

    const visibleUserMessages = useMemo(() => {
        const items: UserMessageItem[] = []
        for (const message of props.messages) {
            const item = buildUserMessageItem(message, userMessageItemOptions)
            if (item) {
                items.push(item)
            }
        }
        items.sort(sortUserMessageItems)
        return items
    }, [props.messages, userMessageItemOptions])

    const allUserMessages = useMemo(() => {
        const byId = new Map<string, UserMessageItem>()
        for (const item of historyUserMessages) {
            byId.set(item.id, item)
        }
        for (const item of visibleUserMessages) {
            byId.set(item.id, item)
        }
        return [...byId.values()].sort(sortUserMessageItems)
    }, [historyUserMessages, visibleUserMessages])

    const reduced = useMemo(
        () => reduceChatBlocks(normalizedMessages, props.session.agentState),
        [normalizedMessages, props.session.agentState]
    )
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    const maxBlockSeq = useMemo(() => {
        let max = 0
        for (const block of reconciled.blocks) {
            if ('seq' in block && typeof block.seq === 'number' && block.seq > max) {
                max = block.seq
            }
        }
        return max || undefined
    }, [reconciled.blocks])

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelModeChange = useCallback(async (mode: ModelMode) => {
        try {
            await setModelMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model mode:', e)
        }
    }, [setModelMode, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleClearContext = useCallback(() => {
        props.onSend('/clear')
        setForceScrollToken((token) => token + 1)
    }, [props.onSend])

    const handleSend = useCallback((text: string, attachments?: AttachmentMetadata[]) => {
        const trimmed = text.trim()
        if (trimmed.startsWith('/')) {
            const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
            if (name === 'clear' || name === 'compact') {
                props.onSend(text, attachments)
                setForceScrollToken((token) => token + 1)
                return
            }
            if (name === 'status') {
                const statusLines = [
                    `session: ${props.session.id}`,
                    `agent: ${agentFlavor ?? 'unknown'}`,
                    `modelMode: ${props.session.modelMode || 'default'}`,
                    `permissionMode: ${props.session.permissionMode || 'default'}`,
                    `active: ${props.session.active ? 'yes' : 'no'}`,
                    `thinking: ${props.session.thinking ? 'yes' : 'no'}`,
                ]
                addToast({
                    title: '/status',
                    body: statusLines.join('\n'),
                    sessionId: props.session.id,
                    url: ''
                })
                return
            }
            const isSlash = Boolean(name && slashCommands.some(cmd => cmd.name.toLowerCase() === name))
            if (isSlash) {
                addToast({
                    title: 'Slash command',
                    body: `/${name} is not supported in the web UI yet. Use the CLI/terminal for now.`,
                    sessionId: props.session.id,
                    url: ''
                })
                return
            }
        }
        props.onSend(text, attachments)
        setForceScrollToken((token) => token + 1)
    }, [props.onSend, slashCommands, addToast, props.session, agentFlavor])

    const loadAllUserMessages = useCallback(async (force = false) => {
        if (!force && (loadingUserHistory || userHistoryLoadedRef.current)) {
            return
        }

        const requestId = userHistoryRequestIdRef.current + 1
        userHistoryRequestIdRef.current = requestId
        setLoadingUserHistory(true)
        setUserHistoryError(null)

        try {
            const byId = new Map<string, UserMessageItem>()
            let beforeSeq: number | null = null
            let pageCount = 0

            while (pageCount < HISTORY_FETCH_MAX_PAGES) {
                const response = await props.api.getMessages(props.session.id, {
                    limit: HISTORY_FETCH_PAGE_SIZE,
                    beforeSeq,
                    role: 'user'
                })
                pageCount += 1

                for (const message of response.messages) {
                    const item = buildUserMessageItem(message, userMessageItemOptions)
                    if (item) {
                        byId.set(item.id, item)
                    }
                }

                if (!response.page.hasMore || response.page.nextBeforeSeq === null) {
                    break
                }
                beforeSeq = response.page.nextBeforeSeq
            }

            if (userHistoryRequestIdRef.current !== requestId) {
                return
            }

            userHistoryLoadedRef.current = true
            setHistoryUserMessages([...byId.values()].sort(sortUserMessageItems))
            setLoadingUserHistory(false)
        } catch (error) {
            if (userHistoryRequestIdRef.current !== requestId) {
                return
            }
            const message = error instanceof Error ? error.message : t('chat.userPanel.loadError')
            setLoadingUserHistory(false)
            setUserHistoryError(message)
        }
    }, [loadingUserHistory, props.api, props.session.id, t, userMessageItemOptions])

    useEffect(() => {
        if (!userPanelOpen || userHistoryLoadedRef.current || loadingUserHistory || userHistoryError) {
            return
        }
        void loadAllUserMessages()
    }, [userPanelOpen, loadingUserHistory, userHistoryError, loadAllUserMessages])

    const copyUserMessage = useCallback(async (item: UserMessageItem) => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(item.copyText)
            } else {
                const textarea = document.createElement('textarea')
                textarea.value = item.copyText
                textarea.setAttribute('readonly', 'true')
                textarea.style.position = 'fixed'
                textarea.style.opacity = '0'
                document.body.appendChild(textarea)
                textarea.focus()
                textarea.select()
                document.execCommand('copy')
                document.body.removeChild(textarea)
            }
            addToast({
                title: t('chat.userPanel.copyTitle'),
                body: t('chat.userPanel.copySuccess'),
                sessionId: props.session.id,
                url: ''
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : t('chat.userPanel.copyFailed')
            addToast({
                title: t('chat.userPanel.copyTitle'),
                body: message,
                sessionId: props.session.id,
                url: ''
            })
        }
    }, [addToast, props.session.id, t])

    const jumpToUserMessage = useCallback(async (item: UserMessageItem) => {
        const targetId = buildUserMessageDomId(item.threadMessageId)
        const scrollToTarget = (behavior: ScrollBehavior = 'auto') => {
            const element = document.getElementById(targetId)
            if (!element) {
                return false
            }
            element.scrollIntoView({ behavior, block: 'center' })
            return true
        }

        if (scrollToTarget('smooth')) {
            setUserPanelOpen(false)
            return
        }

        if (typeof item.seq !== 'number') {
            addToast({
                title: t('chat.userPanel.jumpTitle'),
                body: t('chat.userPanel.jumpFailed'),
                sessionId: props.session.id,
                url: ''
            })
            return
        }

        setJumpingMessageId(item.id)
        try {
            setSuspendAutoLoadNewerToken((token) => token + 1)
            await waitMs(16)
            const loaded = await props.onJumpToMessage(item.seq)
            if (!loaded) {
                addToast({
                    title: t('chat.userPanel.jumpTitle'),
                    body: t('chat.userPanel.jumpFailed'),
                    sessionId: props.session.id,
                    url: ''
                })
                return
            }

            for (let attempt = 0; attempt < JUMP_SCROLL_ATTEMPTS; attempt += 1) {
                if (scrollToTarget('auto')) {
                    await waitMs(24)
                    scrollToTarget('auto')
                    return
                }
                await waitMs(16)
            }

            if (!scrollToTarget('auto')) {
                addToast({
                    title: t('chat.userPanel.jumpTitle'),
                    body: t('chat.userPanel.jumpFailed'),
                    sessionId: props.session.id,
                    url: ''
                })
            }
        } finally {
            setJumpingMessageId((current) => (current === item.id ? null : current))
            setUserPanelOpen(false)
        }
    }, [addToast, props.onJumpToMessage, props.session.id, t])

    const toggleUserPanel = useCallback(() => {
        setUserPanelOpen((open) => !open)
    }, [])

    const handleEnterTrimMode = useCallback(() => {
        setTrimMode(true)
    }, [])

    const handleExitTrimMode = useCallback(() => {
        setTrimMode(false)
    }, [])

    const handleTrim = useCallback(async (action: { mode: 'before' | 'after' | 'single'; seq: number }) => {
        if (!props.api) return
        try {
            await props.api.trimMessages(props.session.id, action)
            clearMessageWindow(props.session.id)
            await fetchLatestMessages(props.api, props.session.id)
            props.onRefresh()
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Failed to trim messages', error)
            const message = error instanceof Error ? error.message : String(error ?? '')
            addToast({
                title: t('dialog.error.default'),
                body: message,
                sessionId: props.session.id,
                url: ''
            })
        }
    }, [props.api, props.session.id, props.onRefresh, addToast, t])

    useEffect(() => {
        if (!userPanelOpen) {
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Element)) {
                return
            }
            if (userPanelRef.current?.contains(target)) {
                return
            }
            if (target.closest('[data-user-panel-toggle="true"]')) {
                return
            }
            setUserPanelOpen(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [userPanelOpen])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: reconciled.blocks,
        isSending: props.isSending,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <div className="flex h-full flex-col">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                api={props.api}
                onSessionDeleted={props.onBack}
                onShare={props.onShare}
                onUnshare={props.onUnshare}
                onEnterTrimMode={handleEnterTrimMode}
            />

            {props.session.teamState && (
                <TeamPanel teamState={props.session.teamState} />
            )}

            {sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Sending will resume it automatically.
                    </div>
                </div>
            ) : null}

            {trimMode ? (
                <div className="px-3 pt-2">
                    <div className="mx-auto w-full max-w-content rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)] flex items-center justify-between gap-2">
                        <div>
                            {t('session.trim.banner')}
                        </div>
                        <button
                            type="button"
                            onClick={handleExitTrimMode}
                            className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            {t('session.trim.exit')}
                        </button>
                    </div>
                </div>
            ) : null}

            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        key={props.session.id}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onForkFromMessage={props.onForkFromMessage}
                        maxBlockSeq={maxBlockSeq}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        hasMoreNewerMessages={props.hasMoreNewerMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        isLoadingNewerMessages={props.isLoadingNewerMessages}
                        onLoadMore={props.onLoadMore}
                        onLoadNewer={props.onLoadNewer}
                        onGoToLatest={props.onGoToLatest}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={props.messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={props.messagesVersion}
                        forceScrollToken={forceScrollToken}
                        suspendAutoLoadNewerToken={suspendAutoLoadNewerToken}
                        trimMode={trimMode}
                        onTrim={handleTrim}
                    />

                    <div className="relative">
                    {userPanelOpen ? (
                        <div
                            ref={userPanelRef}
                            className="absolute bottom-full right-3 z-20 mb-2 w-[min(28rem,calc(100vw-1.5rem))] max-w-full overflow-hidden rounded-lg border border-[var(--app-border)] shadow-xl backdrop-blur-sm"
                        >
                            <div className="absolute inset-0 bg-[var(--app-bg)] opacity-70" aria-hidden="true" />
                                <div className="relative z-10 flex flex-col">
                                    <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] px-3 py-2">
                                        <div className="text-sm font-medium text-[var(--app-fg)]">
                                            {t('chat.userPanel.title', { count: allUserMessages.length })}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => void loadAllUserMessages(true)}
                                            disabled={loadingUserHistory}
                                            className="rounded px-2 py-1 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-60"
                                        >
                                            {loadingUserHistory ? t('chat.userPanel.loading') : t('chat.userPanel.refresh')}
                                        </button>
                                    </div>

                                    <div className="max-h-[min(60vh,32rem)] overflow-y-auto px-2 py-2">
                                        {userHistoryError ? (
                                            <div className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-[var(--app-hint)]">
                                                {t('chat.userPanel.loadError')}: {userHistoryError}
                                            </div>
                                        ) : null}

                                        {allUserMessages.length === 0 && !loadingUserHistory ? (
                                            <div className="px-1 py-2 text-xs text-[var(--app-hint)]">
                                                {t('chat.userPanel.empty')}
                                            </div>
                                        ) : null}

                                        <div className="flex flex-col gap-2">
                                            {allUserMessages.map((item, index) => (
                                                <div
                                                    key={item.id}
                                                    className="rounded-md border border-[var(--app-border)] bg-green-50 px-2 py-2 dark:bg-green-950/30"
                                                >
                                                    <div className="mb-1 line-clamp-3 whitespace-pre-wrap break-words text-xs text-[var(--app-fg)]">
                                                        {item.preview}
                                                    </div>
                                                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--app-hint)]">
                                                        <span>#{index + 1}</span>
                                                        <div className="flex items-center gap-1">
                                                            <button
                                                                type="button"
                                                                onClick={() => void copyUserMessage(item)}
                                                                className="rounded px-2 py-1 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                                            >
                                                                {t('session.action.copy')}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => void jumpToUserMessage(item)}
                                                                disabled={jumpingMessageId === item.id}
                                                                className="rounded px-2 py-1 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-60"
                                                            >
                                                                {jumpingMessageId === item.id ? t('chat.userPanel.jumping') : t('chat.userPanel.jump')}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}

                        <HappyComposer
                            disabled={props.isSending}
                            permissionMode={props.session.permissionMode}
                            modelMode={props.session.modelMode}
                            agentFlavor={agentFlavor}
                            active={props.session.active}
                            allowSendWhenInactive
                            thinking={props.session.thinking}
                            agentState={props.session.agentState}
                            contextSize={reduced.latestUsage?.contextSize}
                            contextModel={props.session.metadata?.resolvedModel ?? reduced.latestUsage?.model}
                            controlledByUser={props.session.agentState?.controlledByUser === true}
                            onPermissionModeChange={handlePermissionModeChange}
                            onModelModeChange={handleModelModeChange}
                            onSwitchToRemote={handleSwitchToRemote}
                            autocompleteSuggestions={props.autocompleteSuggestions}
                            apiClient={props.api}
                            sessionId={props.session.id}
                            voiceStatus={voice?.status}
                            voiceMicMuted={voice?.micMuted}
                            onVoiceToggle={voice ? handleVoiceToggle : undefined}
                            onVoiceMicToggle={voice ? handleVoiceMicToggle : undefined}
                            userMessagesOpen={userPanelOpen}
                            onUserMessagesToggle={toggleUserPanel}
                            onClearContext={handleClearContext}
                        />
                    </div>
                </div>
            </AssistantRuntimeProvider>

            {/* Voice session component - renders nothing but initializes ElevenLabs */}
            {voice && (
                <RealtimeVoiceSession
                    api={props.api}
                    micMuted={voice.micMuted}
                    onStatusChange={voice.setStatus}
                />
            )}
        </div>
    )
}
