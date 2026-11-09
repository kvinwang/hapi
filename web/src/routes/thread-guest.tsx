import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThreadMessage } from '@hapi/protocol/threads'
import { ThreadGuestClient, ThreadGuestError } from '@/api/threadGuest'
import { ThreadComposer } from '@/components/Threads/ThreadComposer'
import { ThreadMessages } from '@/components/Threads/ThreadMessages'
import { threadButton, type Member } from '@/components/Threads/types'
import { Button } from '@/components/ui/button'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useTranslation } from '@/lib/use-translation'
import { GuestCodePrompt, readCode, writeCode } from './guest-session'

function AgentAccess({ baseUrl, grantId, code }: { baseUrl: string; grantId: string; code: string }) {
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    const guide = ThreadGuestClient.guideUrl(baseUrl || window.location.origin, grantId)
    const prompt = t('thread.guest.agentPrompt', { guide, code })
    return (
        <details className="mx-auto max-w-4xl px-4 py-2 text-sm">
            <summary className="cursor-pointer font-medium">{t('thread.guest.agent')}</summary>
            <p className="mt-2 text-[var(--app-hint)]">{t('thread.guest.agentHint')}</p>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-md bg-[var(--app-subtle-bg)] p-3 font-mono text-xs">{prompt}</pre>
            <div className="mt-2 flex items-center gap-3">
                <Button type="button" size="sm" onClick={() => void copy(prompt)}>
                    {copied ? t('guest.access.copied') : t('thread.guest.copyPrompt')}
                </Button>
                <a className="text-[var(--app-link)]" href={guide} target="_blank" rel="noreferrer noopener">agent.md</a>
            </div>
        </details>
    )
}

function ThreadGuestLive({ client, baseUrl, code, onRejected }: { client: ThreadGuestClient; baseUrl: string; code: string; onRejected: () => void }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [reply, setReply] = useState<ThreadMessage>()
    const [notice, setNotice] = useState('')
    const scrolling = useRef<HTMLElement>(null)
    const info = useQuery({ queryKey: ['thread-guest', client.grantId], queryFn: () => client.view(), refetchInterval: 15_000, retry: false })
    const history = useInfiniteQuery({
        queryKey: ['thread-guest', client.grantId, 'messages'],
        initialPageParam: undefined as number | undefined,
        queryFn: ({ pageParam }) => client.history(pageParam),
        getNextPageParam: page => (page.hasMore ? page.messages[0]?.seq : undefined),
        enabled: Boolean(info.data),
        refetchInterval: 4_000,
        retry: false
    })
    const rejected = [info.error, history.error].some(error => error instanceof ThreadGuestError && error.status === 401)
    useEffect(() => {
        if (rejected) onRejected()
    }, [rejected, onRejected])
    const messages = useMemo(() => {
        const unique = new Map<string, ThreadMessage>()
        for (const page of history.data?.pages ?? []) for (const message of page.messages) unique.set(message.id, message)
        return [...unique.values()].sort((a, b) => a.seq - b.seq)
    }, [history.data])
    useEffect(() => {
        const el = scrolling.current
        if (el) el.scrollTop = el.scrollHeight
    }, [messages.length])
    const members = useMemo<Member[]>(
        () => (info.data?.members ?? []).map(member => ({ id: member.id, kind: member.kind, title: member.name, status: member.kind, mentionWake: true, joinedAt: 0 })),
        [info.data]
    )
    const onSend = useCallback(async (input: Parameters<ThreadGuestClient['send']>[0]) => {
        try {
            const { wake } = await client.send(input)
            setNotice(wake === 'budget' ? t('thread.guest.budget') : '')
            setReply(undefined)
            await queryClient.invalidateQueries({ queryKey: ['thread-guest', client.grantId, 'messages'] })
            return true
        } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error))
            return false
        }
    }, [client, queryClient, t])
    if (info.error && !rejected) return <p role="alert" className="p-8 text-center">{t('thread.guest.unavailable')}</p>
    if (!info.data) return <p className="p-8 text-center text-[var(--app-hint)]">{t('loading')}</p>
    const { thread, guest } = info.data
    const name = (id: string) => members.find(member => member.id === id)?.title ?? id.slice(0, 8)
    return (
        <main className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="shrink-0 border-b border-[var(--app-divider)] px-4 py-3">
                <div className="mx-auto max-w-4xl">
                    <h1 className="truncate text-lg font-semibold">{thread.name}</h1>
                    <p className="text-xs text-[var(--app-hint)]">
                        {t('thread.guest.as', { name: guest.name })}
                        {thread.archived ? ` · ${t('session.threads.archived')}` : ''}
                    </p>
                    {thread.description && <p className="mt-1 text-sm text-[var(--app-hint)]">{thread.description}</p>}
                </div>
            </header>
            <div className="shrink-0 border-b border-[var(--app-divider)]">
                <AgentAccess baseUrl={baseUrl} grantId={client.grantId} code={code} />
            </div>
            <section ref={scrolling} aria-label={thread.name} className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-4xl space-y-5 px-4 py-5">
                    {history.hasNextPage && (
                        <div className="text-center">
                            <button className={threadButton} disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>
                                {t('thread.share.older')}
                            </button>
                        </div>
                    )}
                    {!history.isPending && !messages.length && <p className="py-8 text-center text-[var(--app-hint)]">{t('thread.share.empty')}</p>}
                    <ThreadMessages messages={messages} name={name} onReply={thread.archived ? undefined : setReply} />
                </div>
            </section>
            {notice && <p role="status" className="shrink-0 px-4 py-2 text-sm text-[var(--app-hint)]">{notice}</p>}
            {!thread.archived && (
                <footer className="shrink-0 border-t border-[var(--app-divider)]">
                    <ThreadComposer members={members} reply={reply} onCancelReply={() => setReply(undefined)} onSend={onSend} />
                </footer>
            )}
        </main>
    )
}

/** A thread guest link: asks for the access code, then shows only that thread. Never mounts the owner shell. */
export default function ThreadGuestPage({ grantId }: { grantId: string }) {
    const { t } = useTranslation()
    const { baseUrl } = useServerUrl()
    const storageKey = `hapi_thread_guest_code::${baseUrl}::${grantId}`
    const [code, setCode] = useState(() => readCode(storageKey))
    const [rejected, setRejected] = useState(false)
    const client = useMemo(() => (code ? new ThreadGuestClient(baseUrl, grantId, code) : null), [baseUrl, grantId, code])
    const reject = useCallback(() => {
        writeCode(storageKey, null)
        setRejected(true)
        setCode(null)
    }, [storageKey])
    if (!client || !code) {
        return (
            <GuestCodePrompt
                title={t('thread.guest.join')}
                error={rejected}
                onSubmit={value => {
                    writeCode(storageKey, value)
                    setRejected(false)
                    setCode(value)
                }}
            />
        )
    }
    return <ThreadGuestLive key={code} client={client} baseUrl={baseUrl} code={code} onRejected={reject} />
}
