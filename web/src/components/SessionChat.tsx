import { Profiler, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type {
    AttachmentMetadata,
    DecryptedMessage,
    ModelMode,
    PermissionMode,
    Session,
    SlashCommand
} from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@hapi/protocol/chat'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import { reduceChatBlocks } from '@/chat/reducer'
import { collectMessageUsagePoints, findMessageUsageAtSeq } from '@/chat/messageUsage'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildVisibleChatBlocks, isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import { HappyComposer } from '@/components/AssistantChat/HappyComposer'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { buildUserMessageDomId } from '@/components/AssistantChat/messages/domIds'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { clearMessageWindow, fetchLatestMessages } from '@/lib/message-window-store'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { findUnsupportedCodexBuiltinSlashCommand } from '@/lib/codexSlashCommands'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { SessionHeader } from '@/components/SessionHeader'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/hooks/usePlatform'
import { useLandscapeViewMode } from '@/hooks/useLandscapeViewMode'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useVoiceOptional } from '@/lib/voice-context'
import { RealtimeVoiceSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import { isSessionChatPerfEnabled, measureSessionChatStage, recordSessionChatDuration } from '@/lib/session-chat-performance'
import { nextAnimationFrame, waitForElementById } from '@/lib/wait-for-element'

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
    message: NormalizedMessage,
    options: {
        emptyFallback: string
        attachmentsFallback: (count: number) => string
    }
): UserMessageItem | null {
    if (message.role !== 'user') {
        return null
    }
    const content = message.content
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
        seq: message.seq ?? null,
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

function buildHistoryUserMessageItem(message: {
    id: string
    seq: number
    createdAt: number
    text: string
}, emptyFallback: string): UserMessageItem {
    const trimmed = message.text.trim()
    const base = trimmed || emptyFallback
    return {
        id: message.id,
        threadMessageId: `user:${message.id}`,
        seq: message.seq,
        createdAt: message.createdAt,
        preview: base.length > USER_MESSAGE_PREVIEW_LIMIT
            ? `${base.slice(0, USER_MESSAGE_PREVIEW_LIMIT - 1)}…`
            : base,
        copyText: message.text || base
    }
}

/**
 * React's Profiler is only mounted when chat instrumentation is switched on.
 *
 * It used to wrap the whole thread unconditionally, so every production commit paid for
 * profiling timers plus a `recordSessionChatDuration` call — on the hot path of a view
 * that re-renders several times a second while an agent streams.
 */
function ThreadProfiler(props: { children: ReactNode }) {
    if (!isSessionChatPerfEnabled()) return <>{props.children}</>
    return (
        <Profiler
            id="SessionChatThread"
            onRender={(_id, phase, actualDuration) => {
                recordSessionChatDuration(`reactCommit.${phase}`, actualDuration)
            }}
        >
            {props.children}
        </Profiler>
    )
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
    onForkFullHistory?: (messageSeq: number) => void
    onShare?: () => void
    onUnshare?: () => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const sessionInactive = !props.session.active
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    const normalizedCacheRef = useRef<Map<string, { source: DecryptedMessage; normalized: NormalizedMessage | null }>>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const visibleGroupsRef = useRef<ToolGroupBlock[]>([])
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const { abortSession, interruptSession, switchSession, setPermissionMode, setModelMode, setEffortMode } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor
    )
    const { addToast } = useToast()
    const { commands: slashCommands } = useSlashCommands(props.api, props.session.id, agentFlavor ?? 'claude')
    // Account-specific Claude models detected on the session's machine (for the model switcher)
    const sessionMachineId = props.session.metadata?.machineId ?? null
    const isClaudeSession = (agentFlavor ?? 'claude') === 'claude'
    const { machines } = useMachines(props.api, Boolean(sessionMachineId && isClaudeSession))
    const detectedClaudeModels = useMemo(() => {
        if (!sessionMachineId || !isClaudeSession) return null
        const machine = machines.find((m) => m.id === sessionMachineId)
        return machine?.metadata?.claudeModels ?? null
    }, [machines, sessionMachineId, isClaudeSession])
    const [userPanelOpen, setUserPanelOpen] = useState(false)
    const [loadingUserHistory, setLoadingUserHistory] = useState(false)
    const [userHistoryError, setUserHistoryError] = useState<string | null>(null)
    const [jumpingMessageId, setJumpingMessageId] = useState<string | null>(null)
    const [suspendAutoLoadNewerToken, setSuspendAutoLoadNewerToken] = useState(0)
    // Config RPCs and message sends use separate HTTP/socket paths. Serialize them so a
    // message can never overtake a model/permission/effort change in flight.
    const configMutationChainRef = useRef<Promise<void>>(Promise.resolve())

    const enqueueConfigMutation = useCallback((mutation: () => Promise<void>): Promise<void> => {
        const task = configMutationChainRef.current
            .catch(() => undefined)
            .then(mutation)
        configMutationChainRef.current = task
        return task
    }, [])
    const [historyUserMessages, setHistoryUserMessages] = useState<UserMessageItem[]>([])
    const userHistoryLoadedRef = useRef(false)
    const userHistoryRequestIdRef = useRef(0)
    const userPanelRef = useRef<HTMLDivElement | null>(null)
    const [trimMode, setTrimMode] = useState(false)
    const [viewMode, setViewMode] = useState(false)
    // A handset turned sideways drops into view mode and comes back out when it
    // is turned upright again.
    useLandscapeViewMode(true, setViewMode)
    const [isDeviceFullscreen, setIsDeviceFullscreen] = useState(false)
    // iPhone Safari has no Fullscreen API for pages (video-only); iPadOS 16+,
    // Android and desktop do. Hide the toggle where it cannot work.
    const [deviceFullscreenSupported] = useState(() =>
        typeof document !== 'undefined' && document.fullscreenEnabled
    )

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsDeviceFullscreen(Boolean(document.fullscreenElement))
        }
        document.addEventListener('fullscreenchange', handleFullscreenChange)
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }, [])

    const handleToggleDeviceFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {})
        } else {
            void document.documentElement.requestFullscreen().catch(() => {})
        }
    }, [])

    const handleExitViewMode = useCallback(() => {
        setViewMode(false)
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {})
        }
    }, [])

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

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        blocksByIdRef.current.clear()
        visibleGroupsRef.current = []
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

        return measureSessionChatStage('normalize', () => {
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
        })
    }, [props.messages])

    const userMessageItemOptions = useMemo(() => ({
        emptyFallback: t('chat.userPanel.emptyMessage'),
        attachmentsFallback: (count: number) => t('chat.userPanel.attachmentsOnly', { count })
    }), [t])

    const visibleUserMessages = useMemo(() => {
        const items: UserMessageItem[] = []
        for (const message of normalizedMessages) {
            const item = buildUserMessageItem(message, userMessageItemOptions)
            if (item) {
                items.push(item)
            }
        }
        items.sort(sortUserMessageItems)
        return items
    }, [normalizedMessages, userMessageItemOptions])

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
        () => measureSessionChatStage(
            'reduce',
            () => reduceChatBlocks(normalizedMessages, props.session.agentState)
        ),
        [normalizedMessages, props.session.agentState]
    )
    const messageUsagePoints = useMemo(
        () => collectMessageUsagePoints(normalizedMessages),
        [normalizedMessages]
    )
    const getUsageAtSeq = useCallback(
        (seq: number) => findMessageUsageAtSeq(messageUsagePoints, seq),
        [messageUsagePoints]
    )
    const reconciled = useMemo(
        () => measureSessionChatStage(
            'reconcile',
            () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current)
        ),
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

    const visibleBlocks = useMemo(
        () => measureSessionChatStage('group', () => buildVisibleChatBlocks(reconciled.blocks, {
            previousGroups: visibleGroupsRef.current
        })),
        [reconciled.blocks]
    )

    useEffect(() => {
        visibleGroupsRef.current = visibleBlocks.filter(isToolGroupBlock)
    }, [visibleBlocks])

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await enqueueConfigMutation(() => setPermissionMode(mode))
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic, enqueueConfigMutation])

    // Model mode change handler
    const handleModelModeChange = useCallback(async (mode: ModelMode) => {
        try {
            await enqueueConfigMutation(() => setModelMode(mode))
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model mode:', e)
        }
    }, [setModelMode, props.onRefresh, haptic, enqueueConfigMutation])

    const handleEffortModeChange = useCallback(async (mode: string) => {
        try {
            await enqueueConfigMutation(() => setEffortMode(mode))
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set effort mode:', e)
        }
    }, [setEffortMode, props.onRefresh, haptic, enqueueConfigMutation])

    // Abort handler.
    // For Claude sessions the first press sends a graceful interrupt (same as
    // pressing Esc in the Claude Code terminal — the agent stops at a safe point
    // and the in-flight turn is preserved). Pressing again within the escalation
    // window — or an interrupt RPC failure (old CLI / offline) — falls back to
    // the hard abort that kills the in-flight turn process.
    const lastInterruptAtRef = useRef(0)
    const handleAbort = useCallback(async () => {
        const now = Date.now()
        const sinceLastInterrupt = now - lastInterruptAtRef.current
        // Ignore likely-accidental double clicks
        if (sinceLastInterrupt < 800) return
        const escalate = sinceLastInterrupt < 15_000
        if (isClaudeSession && !escalate) {
            lastInterruptAtRef.current = now
            try {
                await interruptSession()
                return
            } catch (e) {
                console.warn('Interrupt failed, falling back to hard abort:', e)
            }
        }
        lastInterruptAtRef.current = 0
        await abortSession()
        props.onRefresh()
    }, [abortSession, interruptSession, isClaudeSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleClearContext = useCallback(() => {
        props.onSend('/clear')
        setForceScrollToken((token) => token + 1)
    }, [props.onSend])

    const handleSend = useCallback(async (text: string, attachments?: AttachmentMetadata[]) => {
        if (agentFlavor === 'codex') {
            const unsupportedCommand = findUnsupportedCodexBuiltinSlashCommand(
                text,
                props.availableSlashCommands ?? []
            )
            if (unsupportedCommand) {
                haptic.notification('error')
                addToast({
                    title: t('composer.codexSlashUnsupported.title'),
                    body: t('composer.codexSlashUnsupported.body', { command: `/${unsupportedCommand}` }),
                    sessionId: props.session.id,
                    url: `/sessions/${props.session.id}`
                })
                return
            }
        }
        const trimmed = text.trim()
        if (trimmed.startsWith('/')) {
            const name = trimmed.slice(1).split(/\s+/)[0]?.toLowerCase()
            if (name === 'clear' || name === 'compact') {
                await configMutationChainRef.current.catch(() => undefined)
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
        await configMutationChainRef.current.catch(() => undefined)
        props.onSend(text, attachments)
        setForceScrollToken((token) => token + 1)
    }, [
        addToast,
        agentFlavor,
        haptic,
        props.availableSlashCommands,
        props.onSend,
        props.session.active,
        props.session.id,
        props.session.modelMode,
        props.session.permissionMode,
        props.session.thinking,
        slashCommands,
        t
    ])

    const loadAllUserMessages = useCallback(async (force = false) => {
        if (!force && (loadingUserHistory || userHistoryLoadedRef.current)) {
            return
        }

        const requestId = userHistoryRequestIdRef.current + 1
        userHistoryRequestIdRef.current = requestId
        setLoadingUserHistory(true)
        setUserHistoryError(null)

        try {
            const response = await props.api.getUserMessages(props.session.id, 50_000)
            const items = response.messages.map((message) => (
                buildHistoryUserMessageItem(message, userMessageItemOptions.emptyFallback)
            ))

            if (userHistoryRequestIdRef.current !== requestId) {
                return
            }

            userHistoryLoadedRef.current = true
            setHistoryUserMessages(items.sort(sortUserMessageItems))
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
            await nextAnimationFrame()
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

            const target = await waitForElementById(targetId)
            if (target) {
                await nextAnimationFrame()
                target.scrollIntoView({ behavior: 'auto', block: 'center' })
                return
            } else {
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
        blocks: visibleBlocks,
        isSending: props.isSending,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true
    })

    return (
        <div className="flex h-full min-h-0 flex-col">
            {viewMode ? (
                <div
                    className="fixed right-3 z-50 flex items-center gap-2"
                    style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
                >
                    {deviceFullscreenSupported ? (
                    <button
                        type="button"
                        onClick={handleToggleDeviceFullscreen}
                        title={isDeviceFullscreen ? t('viewMode.fullscreen.exit') : t('viewMode.fullscreen.enter')}
                        className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-md transition-colors hover:bg-[var(--app-secondary-bg)]"
                    >
                        {isDeviceFullscreen ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                            </svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                            </svg>
                        )}
                    </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={handleExitViewMode}
                        title={t('viewMode.exit')}
                        className="flex h-9 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-xs font-medium text-[var(--app-fg)] shadow-md transition-colors hover:bg-[var(--app-secondary-bg)]"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                        </svg>
                        {t('viewMode.exit')}
                    </button>
                </div>
            ) : null}

            {!viewMode ? (
                <SessionHeader
                    session={props.session}
                    onBack={props.onBack}
                    api={props.api}
                    onSessionDeleted={props.onBack}
                    onShare={props.onShare}
                    onUnshare={props.onUnshare}
                    onEnterTrimMode={handleEnterTrimMode}
                    onEnterViewMode={() => { setTrimMode(false); setViewMode(true) }}
                />
            ) : null}

            {!viewMode && props.session.teamState && (
                <TeamPanel teamState={props.session.teamState} />
            )}

            {!viewMode && sessionInactive ? (
                <div className="px-3 pt-3">
                    <div className="mx-auto w-full max-w-content rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                        Session is inactive. Sending will resume it automatically.
                    </div>
                </div>
            ) : null}

            {!viewMode && trimMode ? (
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
                    <ThreadProfiler>
                    <HappyThread
                        key={props.session.id}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onForkFromMessage={props.onForkFromMessage}
                        onForkFullHistory={props.onForkFullHistory}
                        maxBlockSeq={maxBlockSeq}
                        contextWindowTokens={props.session.metadata?.contextWindowTokens ?? null}
                        getUsageAtSeq={getUsageAtSeq}
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
                    </ThreadProfiler>

                    {!viewMode ? (
                    <div className="relative">
                    {userPanelOpen ? (
                        <div
                            ref={userPanelRef}
                            className="absolute bottom-full right-3 z-20 mb-2 w-[min(28rem,calc(100vw-1.5rem))] max-w-full overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-xl"
                        >
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
                            effortMode={props.session.effortMode ?? props.session.metadata?.effortMode}
                            agentFlavor={agentFlavor}
                            claudeModels={detectedClaudeModels}
                            active={props.session.active}
                            allowSendWhenInactive
                            thinking={props.session.thinking}
                            agentState={props.session.agentState}
                            contextSize={reduced.latestUsage?.contextSize}
                            contextModel={props.session.metadata?.resolvedModel ?? reduced.latestUsage?.model}
                            contextWindowTokens={props.session.metadata?.contextWindowTokens ?? null}
                            agentModelCatalog={props.session.metadata?.agentModelCatalog ?? null}
                            controlledByUser={props.session.agentState?.controlledByUser === true}
                            onPermissionModeChange={handlePermissionModeChange}
                            onModelModeChange={handleModelModeChange}
                            onEffortModeChange={handleEffortModeChange}
                            onSwitchToRemote={handleSwitchToRemote}
                            terminalUnsupported={props.session.active && !terminalSupported}
                            autocompleteSuggestions={props.autocompleteSuggestions}
                            apiClient={props.api}
                            sessionId={props.session.id}
                            sessionUsage={reduced.latestUsage}
                            goalAvailable={props.session.metadata?.goalAvailable === true}
                            goal={props.session.metadata?.goal}
                            voiceStatus={voice?.status}
                            voiceMicMuted={voice?.micMuted}
                            onVoiceMicToggle={voice ? handleVoiceMicToggle : undefined}
                            userMessagesOpen={userPanelOpen}
                            onUserMessagesToggle={toggleUserPanel}
                            onClearContext={handleClearContext}
                        />
                    </div>
                    ) : null}
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
