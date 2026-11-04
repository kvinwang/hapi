import { useTranslation } from '@/lib/use-translation'
import {
    AssistantRuntimeProvider,
    MessageProvider,
    useExternalStoreRuntime,
    useExternalMessageConverter,
    type ThreadMessageLike
} from '@assistant-ui/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Thread, ThreadInbox, ThreadMessage } from '@hapi/protocol/threads'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { useAppContext } from '@/lib/app-context'
import { ThreadComposer } from './ThreadComposer'
import { ThreadMembers } from './ThreadMembers'
import { threadButton, type Member } from './types'

function toChatMessage(message: ThreadMessage): ThreadMessageLike {
    return {
        id: message.id,
        role: message.sender.kind === 'user' ? 'user' : 'assistant',
        content: [{ type: 'text', text: message.text }],
        createdAt: new Date(message.createdAt)
    }
}

export function ThreadChat({ threadId, fromSession }: { threadId: string; fromSession?: string }) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [archiving, setArchiving] = useState(false)
    const client = useQueryClient()
    const [settings, setSettings] = useState(false)
    const [error, setError] = useState('')
    const [reply, setReply] = useState<ThreadMessage>()
    const [atBottom, setAtBottom] = useState(true)
    const scrolling = useRef<HTMLDivElement>(null)
    const stick = useRef(true)
    const prepend = useRef<{ height: number; top: number } | null>(null)
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
    const renderedMessages = useExternalMessageConverter<ThreadMessage>({
        messages,
        isRunning: false,
        joinStrategy: 'none',
        callback: toChatMessage
    })
    const runtime = useExternalStoreRuntime({
        messages: renderedMessages,
        isRunning: false,
        isDisabled: true,
        onNew: async () => {}
    })
    const members = info.data?.members ?? []
    const thread = info.data?.thread
    const name = (id: string) =>
        members.find(member => member.id === id)?.title ?? (id === 'user' ? 'You' : id.slice(0, 8))
    const jumpToLatest = () => {
        const el = scrolling.current
        if (el) el.scrollTop = el.scrollHeight
        stick.current = true
        setAtBottom(true)
    }
    useLayoutEffect(() => {
        const el = scrolling.current
        if (!el) return
        if (prepend.current && !history.isFetchingNextPage) {
            el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height
            prepend.current = null
        } else if (stick.current) el.scrollTop = el.scrollHeight
    }, [messages, history.isFetchingNextPage])
    useEffect(() => {
        const el = scrolling.current
        if (!el || typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(() => {
            if (stick.current) el.scrollTop = el.scrollHeight
        })
        if (el.firstElementChild) observer.observe(el.firstElementChild)
        return () => observer.disconnect()
    }, [messages.length > 0])
    useEffect(() => {
        const el = scrolling.current
        if (!api || !el || !messages.length) return
        let pending = false
        const consume = () => {
            if (document.visibilityState !== 'visible' || pending) return
            const bounds = el.getBoundingClientRect()
            const ids = messages
                .filter(message => {
                    if (!message.receipts.some(receipt => receipt.memberId === 'user' && !receipt.readAt)) return false
                    const node = document.getElementById(`thread-message-${message.id}`)
                    if (!node) return false
                    const rect = node.getBoundingClientRect()
                    return rect.bottom >= bounds.top && rect.top <= bounds.bottom
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
        el.addEventListener('scroll', consume, { passive: true })
        document.addEventListener('visibilitychange', consume)
        return () => {
            el.removeEventListener('scroll', consume)
            document.removeEventListener('visibilitychange', consume)
        }
    }, [api, messages, client])
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
    if (!api) return <p className="p-4">Sign in to view threads.</p>
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <main className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--app-bg)]">
                <header className="flex shrink-0 items-center gap-3 border-b border-[var(--app-divider)] px-3 py-3">
                    {fromSession ? (
                        <Link to="/sessions/$sessionId" params={{ sessionId: fromSession }} className={threadButton} aria-label="Back to session">←</Link>
                    ) : (
                        <Link to="/threads" className={threadButton} aria-label="Back to threads">←</Link>
                    )}
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate font-semibold">{thread?.name ?? 'Thread'}</h1>
                        <p className="truncate text-xs text-[var(--app-hint)]">
                            {thread?.archived ? 'Archived' : `${members.length} members`}
                            {thread?.description ? ` · ${thread.description}` : ''}
                        </p>
                    </div>
                    {thread && !thread.archived && <button type="button" className={threadButton} aria-label={t('session.threads.archive')} title={t('session.threads.archive')} disabled={archiving} onClick={() => {
                        setArchiving(true)
                        void mutate(() => api.threadRequest(`/${threadId}/archive`, {})).finally(() => setArchiving(false))
                    }}>
                        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v13h14V7M10 11h4" /></svg>
                    </button>}
                    <button
                        className={threadButton}
                        aria-label="Members & settings"
                        title="Members & settings"
                        disabled={!thread}
                        onClick={() => setSettings(true)}
                    >
                        <span aria-hidden="true" className="text-xl">
                            ⋯
                        </span>
                    </button>
                </header>
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
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <div
                        ref={scrolling}
                        role="region"
                        aria-label="Thread messages"
                        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
                        onScroll={e => {
                            const el = e.currentTarget
                            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                            stick.current = near
                            setAtBottom(near)
                        }}
                    >
                        <div className="mx-auto max-w-4xl space-y-5 px-4 py-5">
                            {history.hasNextPage && (
                                <div className="text-center">
                                    <button
                                        className={`${threadButton} text-[var(--app-link)]`}
                                        disabled={history.isFetching}
                                        onClick={() => {
                                            const el = scrolling.current
                                            if (el) {
                                                prepend.current = { height: el.scrollHeight, top: el.scrollTop }
                                                stick.current = false
                                            }
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
                                        <p className="mt-2 text-sm">
                                            Share an update, or mention a session when you need it to act.
                                        </p>
                                    </div>
                                )
                            )}
                            {messages.map((message, index) => {
                                const human = message.sender.kind === 'user'
                                const senderId = message.sender.kind === 'session' ? message.sender.sessionId : 'user'
                                const quoted = messages.find(candidate => candidate.id === message.replyTo)
                                const reads = message.receipts.filter(receipt => receipt.readAt).length
                                const delivered = message.receipts.filter(receipt => receipt.deliveredAt).length
                                return (
                                    <article
                                        id={`thread-message-${message.id}`}
                                        key={message.id}
                                        className={`flex ${human ? 'justify-end' : 'justify-start'}`}
                                    >
                                        <div className="min-w-0 max-w-[92%]">
                                            <div
                                                className={`mb-1 flex items-center gap-2 text-xs text-[var(--app-hint)] ${human ? 'justify-end' : ''}`}
                                            >
                                                <span className="font-medium">{name(senderId)}</span>
                                                <time
                                                    dateTime={new Date(message.createdAt).toISOString()}
                                                    title={new Date(message.createdAt).toLocaleString()}
                                                >
                                                    {new Date(message.createdAt).toLocaleTimeString([], {
                                                        hour: '2-digit',
                                                        minute: '2-digit'
                                                    })}
                                                </time>
                                            </div>
                                            <div
                                                className={`min-w-0 rounded-2xl px-4 py-3 ${human ? 'rounded-tr-sm bg-green-50 dark:bg-green-950/30' : 'rounded-tl-sm bg-[var(--app-subtle-bg)]'}`}
                                            >
                                                {message.replyTo && (
                                                    <button
                                                        className="mb-2 block max-w-full truncate border-l-2 border-[var(--app-link)] pl-2 text-left text-sm text-[var(--app-hint)]"
                                                        onClick={() =>
                                                            document
                                                                .getElementById(`thread-message-${message.replyTo}`)
                                                                ?.scrollIntoView({
                                                                    block: 'center',
                                                                    behavior: 'smooth'
                                                                })
                                                        }
                                                    >
                                                        {quoted
                                                            ? `↩ ${quoted.text.slice(0, 120)}`
                                                            : '↩ Reply to an earlier message'}
                                                    </button>
                                                )}
                                                {!!message.mentions.length && (
                                                    <div className="mb-1 flex flex-wrap gap-2 text-xs text-[var(--app-link)]">
                                                        {message.mentions.map(id => (
                                                            <span key={id}>@{name(id)}</span>
                                                        ))}
                                                    </div>
                                                )}
                                                <MessageProvider index={index} message={renderedMessages[index]}>
                                                    {message.text ? <MarkdownRenderer content={message.text} /> : <p className="text-sm text-[var(--app-hint)]">Requested attention to the conversation</p>}
                                                </MessageProvider>
                                            </div>
                                            <div
                                                className={`mt-1 flex items-center gap-3 text-xs text-[var(--app-hint)] ${human ? 'justify-end' : ''}`}
                                            >
                                                {!thread?.archived && (
                                                    <button
                                                        className="py-1 hover:text-[var(--app-link)]"
                                                        onClick={() => setReply(message)}
                                                    >
                                                        Reply
                                                    </button>
                                                )}
                                                <details>
                                                    <summary className="cursor-pointer py-1">
                                                        {reads
                                                            ? `Read by ${reads}`
                                                            : delivered
                                                              ? `Delivered to ${delivered}`
                                                              : 'Saved'}
                                                    </summary>
                                                    <ul className="space-y-1 py-1">
                                                        {message.receipts.map(receipt => (
                                                            <li key={receipt.memberId}>
                                                                {name(receipt.memberId)}:{' '}
                                                                {receipt.readAt
                                                                    ? 'Read'
                                                                    : receipt.deliveredAt
                                                                      ? 'Delivered'
                                                                      : 'Saved'}
                                                                {receipt.wakeStatus
                                                                    ? ` · ${receipt.wakeStatus}${receipt.reason ? ` (${receipt.reason})` : ''}`
                                                                    : ''}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </details>
                                            </div>
                                        </div>
                                    </article>
                                )
                            })}
                        </div>
                    </div>
                    {!atBottom && (
                        <button
                            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] px-4 py-2 text-sm shadow"
                            onClick={jumpToLatest}
                        >
                            ↓ Latest messages
                        </button>
                    )}
                </div>
                {thread &&
                    (thread.archived ? (
                        <p className="shrink-0 border-t border-[var(--app-divider)] p-4 text-center text-sm text-[var(--app-hint)]">
                            This thread is archived. Its conversation remains available.
                        </p>
                    ) : (
                        <footer className="shrink-0 border-t border-[var(--app-divider)]">
                            <ThreadComposer
                                members={members}
                                reply={reply}
                                onCancelReply={() => setReply(undefined)}
                                onSend={async input => {
                                    const ok = await mutate(() => api.threadRequest(`/${threadId}/send`, input))
                                    if (ok) jumpToLatest()
                                    return ok
                                }}
                            />
                        </footer>
                    ))}
                {thread && (
                    <ThreadMembers
                        thread={thread}
                        members={members}
                        open={settings}
                        onOpenChange={setSettings}
                        mutate={mutate}
                        error={error}
                    />
                )}
            </main>
        </AssistantRuntimeProvider>
    )
}
