import { Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Thread, ThreadInbox, ThreadMessage } from '@hapi/protocol/threads'
import { NewMessagesIndicator } from '@/components/AssistantChat/HappyThread'
import type { ChatComposerHandle } from '@/components/Composer/ChatComposer'
import { ConversationHeaderFrame, useConversationHeaderPlacement } from '@/components/Conversations/ConversationHeaderFrame'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { ThreadComposer } from './ThreadComposer'
import { ThreadMembers } from './ThreadMembers'
import { ThreadMessages } from './ThreadMessages'
import { ThreadShareDialog } from './ThreadShareDialog'
import { ThreadGuestDialog } from './ThreadGuestDialog'
import { ThreadTags } from './ThreadTags'
import { ThreadTagsDialog } from './ThreadTagsDialog'
import { threadButton, type Member } from './types'
import { useThreadScroll } from './useThreadScroll'

const HEADER_BUTTON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:opacity-40'

function HeaderIcon({ children }: { children: ReactNode }) {
    return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{children}</svg>
}

export function ThreadChat({ threadId, fromSession, onBack }: { threadId: string; fromSession?: string; onBack?: () => void }) {
    const { api, guest } = useAppContext()
    const { t } = useTranslation()
    const client = useQueryClient()
    const placement = useConversationHeaderPlacement()
    const [archiving, setArchiving] = useState(false)
    const [settings, setSettings] = useState(false)
    const [editingTags, setEditingTags] = useState(false)
    const [sharing, setSharing] = useState(false)
    const [inviting, setInviting] = useState(false)
    const [error, setError] = useState('')
    const [reply, setReply] = useState<ThreadMessage>()
    const composer = useRef<ChatComposerHandle>(null)
    const info = useQuery({
        queryKey: ['threads', threadId],
        queryFn: () => api!.threadRequest<{ thread: Thread; members: Member[] }>(`/${threadId}`),
        enabled: !!api,
        refetchInterval: 30_000
    })
    const history = useInfiniteQuery({
        queryKey: ['threads', threadId, 'messages'],
        initialPageParam: undefined as number | undefined,
        queryFn: ({ pageParam }) =>
            api!.threadRequest<ThreadInbox>(`/${threadId}/history?limit=50${pageParam ? `&before=${pageParam}` : ''}`),
        getNextPageParam: page => (page.hasMore ? page.messages[0]?.seq : undefined),
        enabled: !!api,
        refetchInterval: 30_000
    })
    const messages = useMemo(() => {
        const unique = new Map<string, ThreadMessage>()
        for (const page of [...(history.data?.pages ?? [])].reverse())
            for (const message of page.messages) unique.set(message.id, message)
        return [...unique.values()].sort((a, b) => a.seq - b.seq)
    }, [history.data])
    const scroll = useThreadScroll(messages, history.isFetchingNextPage)
    const { onScroll, visibleArea } = scroll
    const members = info.data?.members ?? []
    const thread = info.data?.thread
    const name = (id: string) =>
        members.find(member => member.id === id)?.title ?? (id === 'user' ? guest ? 'Owner' : 'You' : id.slice(0, 8))
    useEffect(() => {
        if (!api || !messages.length || guest) return
        let pending = false
        const consume = () => {
            if (document.visibilityState !== 'visible' || pending) return
            const bounds = visibleArea()
            const ids = messages
                .filter(message => {
                    if (!message.receipts.some(receipt => receipt.memberId === 'user' && !receipt.readAt)) return false
                    const rect = document.getElementById(`thread-message-${message.id}`)?.getBoundingClientRect()
                    return Boolean(rect && rect.bottom >= bounds.top && rect.top <= bounds.bottom)
                })
                .map(message => message.id)
                .slice(0, 100)
            if (!ids.length) return
            pending = true
            void api
                .threadRequest('/consume', { ids })
                .then(() => client.invalidateQueries({ queryKey: ['threads'] }))
                .catch(e => setError(String(e)))
                .finally(() => {
                    pending = false
                })
        }
        consume()
        const stopListening = onScroll(consume)
        document.addEventListener('visibilitychange', consume)
        return () => {
            stopListening()
            document.removeEventListener('visibilitychange', consume)
        }
    }, [api, messages, client, guest, onScroll, visibleArea])
    const mutate = async (action: () => Promise<unknown>): Promise<boolean> => {
        setError('')
        try {
            await action()
            await client.invalidateQueries({ queryKey: ['threads'] })
            return true
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return false
        }
    }
    if (guest && (info.error || history.error)) return <div className="p-4"><p role="alert">This thread is no longer available with your access code.</p><button className={threadButton} onClick={onBack}>Back to shared session</button></div>
    if (!api) return <p className="p-4">Sign in to view threads.</p>
    const archiveLabel = t(thread?.archived ? 'session.threads.restore' : 'session.threads.archive')
    const back = <HeaderIcon><polyline points="15 18 9 12 15 6" /></HeaderIcon>
    const header = (
        <ConversationHeaderFrame placement={placement}>
            <div className="flex w-full items-center gap-2 p-3">
                {onBack ? <button type="button" className={HEADER_BUTTON} aria-label="Back to shared session" onClick={onBack}>{back}</button> : fromSession ? (
                    <Link to="/sessions/$sessionId" params={{ sessionId: fromSession }} className={HEADER_BUTTON} aria-label="Back to session">{back}</Link>
                ) : (
                    <Link to="/threads" className={HEADER_BUTTON} aria-label="Back to threads">{back}</Link>
                )}
                <div className="min-w-0 flex-1">
                    <h1 className="truncate font-semibold">{thread?.name ?? 'Thread'}</h1>
                    <p className="truncate text-xs text-[var(--app-hint)]">
                        {thread?.archived ? 'Archived' : `${members.length} members`}
                        {thread?.description ? ` · ${thread.description}` : ''}
                    </p>
                    {thread?.tags.length ? <ThreadTags tags={thread.tags} /> : null}
                </div>
                {thread && !guest && <>
                    <button type="button" className={HEADER_BUTTON} aria-label={t('dialog.properties.tags')} title={t('dialog.properties.tags')} onClick={() => setEditingTags(true)}>
                        <HeaderIcon><path d="M20 13 13 20a2 2 0 0 1-3 0l-8-8V2h10l8 8a2 2 0 0 1 0 3Z" /><circle cx="7" cy="7" r="1" /></HeaderIcon>
                    </button>
                    <button type="button" className={HEADER_BUTTON} aria-label={archiveLabel} title={archiveLabel} disabled={archiving} onClick={() => {
                        setArchiving(true)
                        void mutate(() => api.threadRequest(`/${threadId}/${thread.archived ? 'restore' : 'archive'}`, {})).finally(() => setArchiving(false))
                    }}>
                        <HeaderIcon><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v13h14V7" />{thread.archived ? <path d="M12 17V10m-3 3 3-3 3 3" /> : <path d="M10 11h4" />}</HeaderIcon>
                    </button>
                    <button type="button" className={HEADER_BUTTON} aria-label={t('session.action.share')} title={t('session.action.share')} onClick={() => setSharing(true)}>
                        <HeaderIcon><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 10.5 6.8-4m-6.8 7 6.8 4" /></HeaderIcon>
                    </button>
                    <button type="button" className={HEADER_BUTTON} aria-label={t('thread.guest.title')} title={t('thread.guest.title')} onClick={() => setInviting(true)}>
                        <HeaderIcon><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M19 8v6m-3-3h6" /></HeaderIcon>
                    </button>
                    <button type="button" className={HEADER_BUTTON} aria-label="Members & settings" title="Members & settings" onClick={() => setSettings(true)}>
                        <span aria-hidden="true" className="text-xl">⋯</span>
                    </button>
                </>}
            </div>
        </ConversationHeaderFrame>
    )
    return (
        <div className="conversation-chat doc-flow doc-fill flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            {placement === 'top' ? header : null}
            {thread && !guest && editingTags && <ThreadTagsDialog key={thread.id} thread={thread} onClose={() => setEditingTags(false)} />}
            {(error || info.error || history.error) && (
                <div role="alert" className="shrink-0 px-4 py-2 text-sm text-red-500">
                    {error || String(info.error || history.error)}
                    <button
                        className={threadButton}
                        onClick={() => {
                            void info.refetch()
                            void history.refetch()
                            setError('')
                        }}
                    >
                        Retry
                    </button>
                </div>
            )}
            {thread && thread.wakeCount >= thread.wakeLimit && (
                <p role="status" className="shrink-0 bg-[var(--app-subtle-bg)] px-4 py-2 text-sm">
                    Automatic wake limit reached. A message from you resets the budget.
                </p>
            )}
            <div className="doc-flow relative flex min-h-0 flex-1 flex-col">
                <div ref={scroll.viewport} role="region" aria-label="Thread messages" className="doc-flow chat-viewport app-scroll-y min-h-0 flex-1 overflow-x-hidden [overflow-anchor:none]">
                    <div className="chat-content mx-auto max-w-content space-y-5 px-4 py-5">
                        {history.hasNextPage && (
                            <div className="text-center">
                                <button
                                    className={`${threadButton} text-[var(--app-link)]`}
                                    disabled={history.isFetching}
                                    onClick={() => {
                                        scroll.keepPositionOnPrepend()
                                        void history.fetchNextPage()
                                    }}
                                >
                                    {history.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
                                </button>
                            </div>
                        )}
                        {history.isPending ? (
                            <p className="py-12 text-center text-[var(--app-hint)]">Loading conversation…</p>
                        ) : (
                            !messages.length && (
                                <div className="py-16 text-center text-[var(--app-hint)]">
                                    <p className="font-medium">Start the conversation</p>
                                    <p className="mt-2 text-sm">Share an update, or mention a session when you need it to act.</p>
                                </div>
                            )
                        )}
                        <ThreadMessages
                            messages={messages}
                            name={name}
                            onReply={thread?.archived ? undefined : message => {
                                setReply(message)
                                composer.current?.open()
                            }}
                            api={guest ? undefined : api}
                            showReceipts={!guest}
                        />
                    </div>
                </div>
                <NewMessagesIndicator count={0} showGoLatest={!scroll.atBottom} isLoading={false} fixed={scroll.documentScroll} onClick={scroll.jumpToLatest} />
            </div>
            {thread && (thread.archived ? (
                <div className="shrink-0 border-t border-[var(--app-divider)] p-4 text-center text-sm text-[var(--app-hint)]">
                    <p>This thread is archived. Its conversation remains available.</p>
                </div>
            ) : (
                <ThreadComposer
                    ref={composer}
                    members={members}
                    reply={reply}
                    onCancelReply={() => setReply(undefined)}
                    onSend={async input => {
                        const ok = await mutate(() => api.threadRequest(`/${threadId}/send`, input))
                        if (ok) scroll.jumpToLatest()
                        return ok
                    }}
                />
            ))}
            {placement === 'bottom' ? header : null}
            {thread && !guest && (
                <ThreadMembers thread={thread} members={members} open={settings} onOpenChange={setSettings} mutate={mutate} error={error} />
            )}
            {thread && !guest && <ThreadShareDialog threadId={threadId} open={sharing} onOpenChange={setSharing} />}
            {thread && !guest && <ThreadGuestDialog threadId={threadId} open={inviting} onOpenChange={setInviting} />}
        </div>
    )
}
