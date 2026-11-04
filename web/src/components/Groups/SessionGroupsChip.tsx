import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { Group } from '@hapi/protocol/groups'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

export function SessionGroupsChip({ api, sessionId }: { api: ApiClient; sessionId: string }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const { data } = useQuery({
        queryKey: ['groups', 'session', sessionId],
        queryFn: () => api.groupRequest<{ groups: Array<Group & { unread: number }> }>(`?sessionId=${encodeURIComponent(sessionId)}`),
        refetchInterval: 30_000
    })
    const groups = data?.groups ?? []
    if (!groups.length) return null
    const unread = groups.reduce((total, group) => total + group.unread, 0)
    return <>
        <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--app-secondary-bg)] px-2 py-0.5 text-[var(--app-hint)] hover:text-[var(--app-link)]">
            {t('session.groups.label', { count: groups.length })}
            {unread > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" aria-label={t('session.groups.unread', { count: unread })} />}
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
                <div className="mb-3 flex items-center justify-between"><DialogTitle>{t('session.groups.title')}</DialogTitle><button type="button" className="rounded p-2" aria-label={t('session.groups.close')} onClick={() => setOpen(false)}>✕</button></div>
                <nav className="space-y-1">{groups.map(group => <Link key={group.id} to="/groups/$groupId" params={{ groupId: group.id }} onClick={() => setOpen(false)} className="block rounded-lg p-3 hover:bg-[var(--app-subtle-bg)]">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>{group.archived && <span className="text-xs text-[var(--app-hint)]">{t('session.groups.archived')}</span>}<span aria-hidden="true">›</span></div>
                    {group.description && <p className="truncate text-sm text-[var(--app-hint)]">{group.description}</p>}
                    {group.unread > 0 && <p className="mt-1 text-xs text-[var(--app-link)]">{t('session.groups.unread', { count: group.unread })}</p>}
                </Link>)}</nav>
            </DialogContent>
        </Dialog>
    </>
}
