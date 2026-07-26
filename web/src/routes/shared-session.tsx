import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useExternalMessageConverter, useExternalStoreRuntime } from '@assistant-ui/react'
import { ApiClient } from '@/api/client'
import type { DecryptedMessage, SharedSessionResponse } from '@/types/api'
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from '@hapi/protocol/chat'
import { buildVisibleChatBlocks, isToolGroupBlock, type ToolGroupBlock, type VisibleChatBlock } from '@/chat/toolGroups'
import { normalizeDecryptedMessage } from '@hapi/protocol/chat'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { toThreadMessageLike } from '@/lib/assistant-runtime'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'

type SharedSession = SharedSessionResponse['session']

function useBaseUrl(): string {
    return typeof window !== 'undefined' ? window.location.origin : ''
}

function getIsFullModeFromLocation(): boolean {
    if (typeof window === 'undefined') return false
    try {
        const params = new URLSearchParams(window.location.search)
        const full = params.get('full')
        if (!full) return false
        const value = full.toLowerCase()
        return value === '1' || value === 'true'
    } catch {
        return false
    }
}

const noop = () => {}
const noopLoadMore = async () => {}

/** In shared/read-only view, nothing is actually running. Force all 'running' tool calls to 'completed'. */
function forceCompleteRunningTools(blocks: ChatBlock[]): void {
    for (const block of blocks) {
        if (block.kind === 'tool-call') {
            const tb = block as ToolCallBlock
            if (tb.tool.state === 'running') {
                tb.tool.state = 'completed'
                tb.tool.completedAt = tb.tool.startedAt
            }
            if (tb.children.length > 0) {
                forceCompleteRunningTools(tb.children)
            }
        }
    }
}

async function loadAllSharedMessages(
    baseUrl: string,
    shareToken: string,
    pageLimit = 200,
    isCancelled?: () => boolean
): Promise<DecryptedMessage[]> {
    const first = await ApiClient.getSharedMessages(baseUrl, shareToken, { afterSeq: 0, limit: pageLimit })
    let allMessages = first.messages as DecryptedMessage[]
    let more = first.page.hasMore
    let lastSeq = allMessages.length > 0 ? allMessages[allMessages.length - 1]?.seq : undefined

    while (more && lastSeq !== undefined) {
        if (isCancelled?.()) {
            return allMessages
        }
        const next = await ApiClient.getSharedMessages(baseUrl, shareToken, {
            afterSeq: lastSeq,
            limit: pageLimit,
        })
        if (isCancelled?.()) {
            return allMessages
        }
        const newMessages = next.messages as DecryptedMessage[]
        if (newMessages.length === 0) {
            break
        }
        allMessages = [...allMessages, ...newMessages]
        more = next.page.hasMore
        lastSeq = newMessages[newMessages.length - 1]?.seq
    }

    return allMessages
}

export default function SharedSessionPage() {
    const { shareToken } = useParams({ from: '/shared/$shareToken' })
    const { t } = useTranslation()
    const baseUrl = useBaseUrl()
    // Read `full` directly from URL search to avoid router stripping unknown keys.
    const isFullMode = getIsFullModeFromLocation()
    const { copied: agentLinkCopied, copy: copyAgentLink } = useCopyToClipboard()

    const [session, setSession] = useState<SharedSession | null>(null)
    const [messages, setMessages] = useState<DecryptedMessage[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [messagesVersion, setMessagesVersion] = useState(0)
    const [isExporting, setIsExporting] = useState(false)

    /** Machine-readable full transcript (curl / agents default to markdown without Accept: text/html). */
    const agentMarkdownUrl = useMemo(() => {
        if (!baseUrl || !shareToken) return ''
        return `${baseUrl}/shared/${encodeURIComponent(shareToken)}?fmt=md`
    }, [baseUrl, shareToken])

    // Set browser tab title to session title
    useEffect(() => {
        if (!session?.title) return
        document.title = session.title
        return () => { document.title = 'HAPI' }
    }, [session?.title])

    // Load session + full message history (paged under the hood, always complete before render).
    useEffect(() => {
        let cancelled = false
        setIsLoading(true)
        setError(null)

        const load = async () => {
            try {
                const [sessionRes, allMessages] = await Promise.all([
                    ApiClient.getSharedSession(baseUrl, shareToken),
                    loadAllSharedMessages(baseUrl, shareToken, 200, () => cancelled),
                ])
                if (cancelled) return

                setSession(sessionRes.session)
                setMessages(allMessages)
                setMessagesVersion((v) => v + 1)
            } catch (err) {
                if (cancelled) return
                setError(err instanceof Error ? err.message : 'Failed to load shared session')
            } finally {
                if (!cancelled) setIsLoading(false)
            }
        }

        void load()
        return () => { cancelled = true }
    }, [baseUrl, shareToken])

    // Normalize → reduce → reconcile → group tools (same pipeline as SessionChat)
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const visibleGroupsRef = useRef<ToolGroupBlock[]>([])

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        const normalized: NormalizedMessage[] = []
        for (const msg of messages) {
            const n = normalizeDecryptedMessage(msg)
            if (n) normalized.push(n)
        }
        return normalized
    }, [messages])

    const reduced = useMemo(
        () => {
            const result = reduceChatBlocks(normalizedMessages, null)
            forceCompleteRunningTools(result.blocks)
            return result
        },
        [normalizedMessages]
    )

    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    // Full history is loaded, so groups never need older-page hydration.
    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, {
            hasMoreMessages: false,
            previousGroups: visibleGroupsRef.current
        }),
        [reconciled.blocks]
    )

    useEffect(() => {
        visibleGroupsRef.current = visibleBlocks.filter(isToolGroupBlock)
    }, [visibleBlocks])

    // Read-only runtime: disabled, not running, no-op callbacks
    const convertedMessages = useExternalMessageConverter<VisibleChatBlock>({
        callback: toThreadMessageLike,
        messages: visibleBlocks as VisibleChatBlock[],
        isRunning: false,
    })

    const adapter = useMemo(() => ({
        isDisabled: true,
        isRunning: false,
        messages: convertedMessages,
        onNew: async () => {},
        onCancel: async () => {},
        unstable_capabilities: { copy: true }
    }), [convertedMessages])

    const runtime = useExternalStoreRuntime(adapter)

    const footer = <div className="h-12" />

    const handleExport = useCallback(async () => {
        if (typeof document === 'undefined') return
        setIsExporting(true)
        try {
            const doc = document
            const cloned = doc.documentElement.cloneNode(true) as HTMLElement

            // Inline stylesheets so the exported document keeps the same UI without external CSS.
            const linkNodes = Array.from(cloned.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[]
            await Promise.all(linkNodes.map(async (link) => {
                const href = link.href
                try {
                    const res = await fetch(href)
                    if (!res.ok) return
                    const css = await res.text()
                    const styleEl = doc.createElement('style')
                    styleEl.textContent = `/* Inlined from ${href} */\n${css}`
                    link.replaceWith(styleEl)
                } catch {
                    // If inlining fails, keep the original link tag.
                }
            }))

            // Remove scripts to avoid rehydrating the app when opening the exported file.
            const scriptNodes = Array.from(cloned.querySelectorAll('script'))
            for (const script of scriptNodes) {
                script.remove()
            }

            // Remove export-only controls from the exported document.
            const exportControls = cloned.querySelectorAll('[data-export-hide=\"true\"]')
            for (const el of Array.from(exportControls)) {
                el.remove()
            }

            const html = '<!doctype html>\n' + cloned.outerHTML
            const blob = new Blob([html], { type: 'text/html' })
            const url = URL.createObjectURL(blob)

            const anchor = doc.createElement('a')
            const title = session?.title?.trim() || 'shared-session'
            const safeTitle = title.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'shared-session'
            anchor.href = url
            anchor.download = `${safeTitle}.html`
            doc.body.appendChild(anchor)
            anchor.click()
            doc.body.removeChild(anchor)

            setTimeout(() => {
                URL.revokeObjectURL(url)
            }, 10_000)
        } finally {
            setIsExporting(false)
        }
    }, [session?.title])

    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <Spinner label="Loading shared session..." />
            </div>
        )
    }

    if (error) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <div className="text-center">
                    <div className="text-lg font-semibold text-[var(--app-fg)]">Session not found</div>
                    <div className="mt-2 text-sm text-[var(--app-hint)]">{error}</div>
                </div>
            </div>
        )
    }

    return (
        <div className="share-page flex h-full flex-col bg-[var(--app-bg)]">
            {/* Header */}
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex max-w-3xl items-center gap-3 px-3 py-3">
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-[var(--app-fg)]">
                            {session?.title ?? 'Shared Session'}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px] font-medium">
                                Read-only
                            </span>
                            {session?.flavor ? (
                                <span>
                                    <span aria-hidden="true">&#10022;</span> {session.flavor}
                                </span>
                            ) : null}
                        </div>
                    </div>
                    {isFullMode ? (
                        <Button
                            data-export-hide="true"
                            variant="outline"
                            size="sm"
                            onClick={handleExport}
                            disabled={isExporting}
                            aria-busy={isExporting}
                            className="shrink-0 text-xs gap-1.5"
                        >
                            {isExporting ? (
                                <>
                                    <Spinner size="sm" label={null} className="text-current" />
                                    {t('shared.exporting')}
                                </>
                            ) : (
                                t('shared.export')
                            )}
                        </Button>
                    ) : null}
                </div>
                {agentMarkdownUrl ? (
                    <div
                        data-export-hide="true"
                        className="mx-auto w-full max-w-3xl px-3 pb-3"
                    >
                        <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-2 text-xs">
                            <div className="min-w-0 flex-1">
                                <div className="mb-0.5 font-medium text-[var(--app-hint)]">
                                    {t('shared.agentHint')}
                                </div>
                                <code
                                    className="block truncate font-mono text-[11px] text-[var(--app-fg)]"
                                    title={agentMarkdownUrl}
                                >
                                    {agentMarkdownUrl}
                                </code>
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="shrink-0 text-xs"
                                onClick={() => {
                                    void copyAgentLink(agentMarkdownUrl)
                                }}
                            >
                                {agentLinkCopied ? t('shared.agentHintCopied') : t('shared.agentHintCopy')}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </div>

            {/* Messages — same rendering pipeline as SessionChat */}
            <AssistantRuntimeProvider runtime={runtime}>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <HappyThread
                        api={null}
                        sessionId={session?.id ?? ''}
                        metadata={null}
                        disabled={true}
                        onRefresh={noop}
                        onRetryMessage={undefined}
                        onForkFromMessage={undefined}
                        onFlushPending={noop}
                        onAtBottomChange={noop}
                        isLoadingMessages={isLoading}
                        messagesWarning={null}
                        hasMoreMessages={false}
                        hasMoreNewerMessages={false}
                        isLoadingMoreMessages={false}
                        isLoadingNewerMessages={false}
                        onLoadMore={noopLoadMore}
                        onLoadNewer={noopLoadMore}
                        onGoToLatest={noopLoadMore}
                        pendingCount={0}
                        rawMessagesCount={messages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={messagesVersion}
                        forceScrollToken={0}
                        staticView={isFullMode}
                        footer={footer}
                        initialAutoScroll={false}
                        showNewMessagesIndicator={false}
                    />
                </div>
            </AssistantRuntimeProvider>
        </div>
    )
}
