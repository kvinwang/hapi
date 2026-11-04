import { ConversationSearch } from '@/components/Conversations/ConversationSearch'
import { useTranslation } from '@/lib/use-translation'
import { ConversationTabs } from '@/components/ConversationTabs'
import { ThreadArchiveFilter } from '@/components/Threads/ThreadArchiveFilter'
import { useThreadArchiveFilter } from '@/hooks/useThreadArchiveFilter'
import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Thread } from '@hapi/protocol/threads'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { threadButton, threadInput } from '@/components/Threads/types'
import { useAppContext } from '@/lib/app-context'

export default function ThreadsPage({ selectedThreadId, onSelect, fromSession, onClose }: { selectedThreadId?: string; onSelect?: () => void; fromSession?: string; onClose?: () => void } = {}) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const [search, setSearch] = useState('')
    const navigate = useNavigate()
    const client = useQueryClient()
    const [creating, setCreating] = useState(false)
    const { hideArchived, toggleArchived } = useThreadArchiveFilter()
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const threads = useQuery({
        queryKey: ['threads'],
        queryFn: () => api!.threadRequest<{ threads: Array<Thread & { unread: number }> }>(''),
        enabled: !!api,
        refetchInterval: 30_000
    })
    const query = search.trim().toLocaleLowerCase()
    const visible = threads.data?.threads.filter(thread => (!hideArchived || !thread.archived)
        && (!query || [thread.name, thread.description, thread.id].some(value => value.toLocaleLowerCase().includes(query)))) ?? []
    if (!api) return <p className="p-4">Sign in to view threads.</p>
    return (
        <main className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="shrink-0 border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-3xl px-3 py-2">
                    <div className="flex items-center justify-between gap-2"><ConversationTabs active="threads" />{onClose && <button type="button" className={threadButton} aria-label="Close sidebar" onClick={onClose}>✕</button>}</div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                        <ThreadArchiveFilter hideArchived={hideArchived} onToggle={toggleArchived} />
                        <button className={threadButton} onClick={() => setCreating(true)}>＋ New thread</button>
                    </div>
                    <ConversationSearch value={search} onChange={setSearch} label={t('session.threads.search')} />
                </div>
            </header>
            <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4">
                {threads.error && <p role="alert">{threads.error.message}</p>}
                {threads.isPending ? (
                    <p className="p-8 text-center text-[var(--app-hint)]">Loading threads…</p>
                ) : !visible.length && query ? (
                    <div className="py-12 text-center text-sm text-[var(--app-hint)]">
                        <p>{t('session.threads.noMatches')}</p>
                        <button type="button" className={`${threadButton} mt-2 text-[var(--app-link)]`} onClick={() => setSearch('')}>{t('session.threads.clearSearch')}</button>
                    </div>
                ) : !visible.length ? (
                    <div className="py-20 text-center">
                        <h2 className="text-lg font-medium">A shared space for your agents</h2>
                        <p className="mt-2 text-[var(--app-hint)]">
                            Create a thread to discuss work and bring sessions together.
                        </p>
                        <button
                            className={`${threadButton} mt-4 text-[var(--app-link)]`}
                            onClick={() => setCreating(true)}
                        >
                            Create thread
                        </button>
                    </div>
                ) : (
                    <nav aria-label="Threads" className="space-y-2">
                        {visible.map(thread => (
                            <Link
                                key={thread.id}
                                to="/threads/$threadId"
                                params={{ threadId: thread.id }}
                                search={{ fromSession }}
                                onClick={onSelect}
                                aria-current={selectedThreadId === thread.id ? 'page' : undefined}
                                className={`flex items-center gap-3 rounded-xl p-3 hover:bg-[var(--app-subtle-bg)] ${selectedThreadId === thread.id ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                            >
                                <span
                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-lg"
                                    aria-hidden="true"
                                >
                                    #
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold">
                                        {thread.name}
                                        {thread.archived && (
                                            <span className="ml-2 text-xs font-normal text-[var(--app-hint)]">
                                                Archived
                                            </span>
                                        )}
                                    </div>
                                    <p className="truncate text-sm text-[var(--app-hint)]">
                                        {thread.description || 'Open conversation'}
                                    </p>
                                </div>
                                {thread.unread > 0 && (
                                    <span
                                        aria-label={`${thread.unread} unread`}
                                        className="rounded-full bg-[var(--app-link)] px-2 py-0.5 text-xs text-white"
                                    >
                                        {thread.unread}
                                    </span>
                                )}
                                <span aria-hidden="true" className="text-[var(--app-hint)]">
                                    ›
                                </span>
                            </Link>
                        ))}
                    </nav>
                )}
            </div>
            <Dialog
                open={creating}
                onOpenChange={open => {
                    if (!busy) {
                        setCreating(open)
                        setError('')
                    }
                }}
            >
                <DialogContent>
                    <DialogTitle>New thread</DialogTitle>
                    <DialogDescription className="mt-2">
                        Give your sessions a shared place to collaborate.
                    </DialogDescription>
                    <form
                        className="mt-4 space-y-3"
                        onSubmit={e => {
                            e.preventDefault()
                            if (busy) return
                            setBusy(true)
                            setError('')
                            void api
                                .threadRequest<{ thread: Thread }>('', { name, description })
                                .then(async result => {
                                    await client.invalidateQueries({ queryKey: ['threads'] })
                                    setCreating(false)
                                    await navigate({ to: '/threads/$threadId', params: { threadId: result.thread.id } })
                                })
                                .catch(e => setError(String(e)))
                                .finally(() => setBusy(false))
                        }}
                    >
                        <input
                            aria-label="Thread name"
                            autoFocus
                            placeholder="Thread name"
                            className={threadInput}
                            value={name}
                            onChange={e => setName(e.target.value)}
                            required
                            maxLength={120}
                            disabled={busy}
                        />
                        <textarea
                            aria-label="Purpose"
                            placeholder="What is this thread working on?"
                            className={threadInput}
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            maxLength={2000}
                            disabled={busy}
                        />
                        {error && (
                            <p role="alert" className="text-red-500">
                                {error}
                            </p>
                        )}
                        <div className="flex justify-end gap-2">
                            <button
                                type="button"
                                className={threadButton}
                                onClick={() => setCreating(false)}
                                disabled={busy}
                            >
                                Cancel
                            </button>
                            <button className={`${threadButton} text-[var(--app-link)]`} disabled={busy || !name.trim()}>
                                Create thread
                            </button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </main>
    )
}
