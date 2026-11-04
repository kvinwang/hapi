import { useOptionalAppContext } from '@/lib/app-context'
import { ThreadArchiveFilter } from './ThreadArchiveFilter'
import { useThreadArchiveFilter } from '@/hooks/useThreadArchiveFilter'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { Thread } from '@hapi/protocol/threads'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

export function SessionThreadsChip({ api, sessionId }: { api: ApiClient; sessionId: string }) {
    const { t } = useTranslation()
    const guest = useOptionalAppContext()?.guest
    const { hideArchived, toggleArchived } = useThreadArchiveFilter()
    const [open, setOpen] = useState(false)
    const { data } = useQuery({
        queryKey: ['threads', 'session', sessionId],
        queryFn: () => api.threadRequest<{ threads: Array<Thread & { unread: number }> }>(`?sessionId=${encodeURIComponent(guest?.sessionId ?? sessionId)}`),
        refetchInterval: 30_000
    })
    const threads = data?.threads ?? []
    if (!threads.length) return null
    const visible = threads.filter(thread => !hideArchived || !thread.archived)
    const unread = visible.reduce((total, thread) => total + thread.unread, 0)
    return <>
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[var(--app-hint)] hover:text-[var(--app-link)]">
            {t('session.threads.label', { count: visible.length })}
            {unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" aria-label={t('session.threads.unread', { count: unread })} />}
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
                <div className="mb-3 flex items-center justify-between"><DialogTitle>{t('session.threads.title')}</DialogTitle><button type="button" className="rounded p-2" aria-label={t('session.threads.close')} onClick={() => setOpen(false)}>✕</button></div>
                <ThreadArchiveFilter hideArchived={hideArchived} onToggle={toggleArchived} />
                {!visible.length && <p className="p-3 text-sm text-[var(--app-hint)]">{t('session.threads.empty')}</p>}
                <nav className="space-y-1">{visible.map(thread => <Link key={thread.id} {...(guest?.grantId ? { to: '/guest/$grantId' as const, params: { grantId: guest.grantId }, search: { threadId: thread.id } } : { to: '/threads/$threadId' as const, params: { threadId: thread.id }, search: { fromSession: sessionId } })} onClick={() => setOpen(false)} className="block rounded-lg p-3 hover:bg-[var(--app-subtle-bg)]">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{thread.name}</span>{thread.archived && <span className="text-xs text-[var(--app-hint)]">{t('session.threads.archived')}</span>}<span aria-hidden="true">›</span></div>
                    {thread.description && <p className="truncate text-sm text-[var(--app-hint)]">{thread.description}</p>}
                    {thread.unread > 0 && <p className="mt-1 text-xs text-[var(--app-link)]">{t('session.threads.unread', { count: thread.unread })}</p>}
                </Link>)}</nav>
            </DialogContent>
        </Dialog>
    </>
}
