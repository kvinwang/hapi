import { useEffect, useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ApiClient } from '@/api/client'
import type { ThreadMessage } from '@hapi/protocol/threads'
import { getPublicContentBaseUrl } from '@/hooks/useServerUrl'
import { useTranslation } from '@/lib/use-translation'
import { ThreadMessages } from '@/components/Threads/ThreadMessages'
import { threadButton } from '@/components/Threads/types'

export default function SharedThreadPage() {
    const { shareToken } = useParams({ from: '/shared/threads/$shareToken' })
    const { t } = useTranslation()
    useEffect(() => {
        const existing = document.querySelector<HTMLMetaElement>('meta[name="referrer"]')
        const meta = existing ?? document.createElement('meta')
        const previous = meta.content
        meta.name = 'referrer'
        meta.content = 'no-referrer'
        if (!existing) document.head.appendChild(meta)
        return () => {
            if (existing) meta.content = previous
            else meta.remove()
        }
    }, [])
    const baseUrl = getPublicContentBaseUrl()
    const info = useQuery({
        queryKey: ['shared-thread', baseUrl, shareToken],
        queryFn: () => ApiClient.getSharedThread(baseUrl, shareToken),
        retry: false,
        refetchInterval: 10_000,
        gcTime: 0
    })
    const history = useInfiniteQuery({
        queryKey: ['shared-thread', baseUrl, shareToken, 'messages'],
        initialPageParam: undefined as number | undefined,
        queryFn: ({ pageParam }) => ApiClient.getSharedThreadMessages(baseUrl, shareToken, pageParam),
        getNextPageParam: page => (page.hasMore ? page.messages[0]?.seq : undefined),
        enabled: Boolean(info.data) && !info.error,
        retry: false,
        refetchInterval: 10_000,
        gcTime: 0
    })
    const messages = useMemo(() => {
        const unique = new Map<string, ThreadMessage>()
        for (const page of history.data?.pages ?? [])
            for (const message of page.messages) unique.set(message.id, message)
        return [...unique.values()].sort((a, b) => a.seq - b.seq)
    }, [history.data])
    useEffect(() => {
        if (!info.data) return
        document.title = info.data.thread.name
        return () => {
            document.title = 'HAPI'
        }
    }, [info.data?.thread.name])
    if (info.error || history.error)
        return (
            <main className="p-8 text-center">
                <p role="alert">{t('thread.share.unavailable')}</p>
                <button
                    className={threadButton}
                    onClick={() => {
                        void info.refetch()
                        void history.refetch()
                    }}
                >
                    {t('sessions.refresh')}
                </button>
            </main>
        )
    if (!info.data || history.isPending) return <p className="p-8 text-center text-[var(--app-hint)]">{t('loading')}</p>
    const { thread, members } = info.data
    return (
        <main className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="shrink-0 border-b border-[var(--app-divider)] px-4 py-3">
                <div className="mx-auto max-w-4xl">
                    <h1 className="truncate text-lg font-semibold">{thread.name}</h1>
                    <p className="text-xs text-[var(--app-hint)]">
                        {t('thread.share.readOnly')}
                        {thread.archived ? ` · ${t('session.threads.archived')}` : ''}
                    </p>
                    {thread.description && <p className="mt-1 text-sm text-[var(--app-hint)]">{thread.description}</p>}
                </div>
            </header>
            <section aria-label={t('thread.share.readOnly')} className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto max-w-4xl space-y-5 px-4 py-5">
                    {history.hasNextPage && (
                        <div className="text-center">
                            <button
                                className={threadButton}
                                disabled={history.isFetching}
                                onClick={() => void history.fetchNextPage()}
                            >
                                {t('thread.share.older')}
                            </button>
                        </div>
                    )}
                    {!messages.length && (
                        <p className="py-8 text-center text-[var(--app-hint)]">{t('thread.share.empty')}</p>
                    )}
                    <ThreadMessages
                        messages={messages}
                        name={id =>
                            members.find(member => member.id === id)?.name ??
                            (id === 'user' ? 'User' : `Session ${id.slice(0, 8)}`)
                        }
                    />
                </div>
            </section>
        </main>
    )
}
