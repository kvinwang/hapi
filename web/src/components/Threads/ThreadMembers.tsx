import { SessionChoiceDetails } from '@/components/SessionChoiceDetails'
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Thread } from '@hapi/protocol/threads'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { ThreadAvatar } from './ThreadAvatar'
import { threadButton, threadInput, memberName, type Member } from './types'

export function ThreadMembers({
    thread,
    members,
    open,
    onOpenChange,
    mutate,
    error
}: {
    thread: Thread
    members: Member[]
    open: boolean
    onOpenChange: (open: boolean) => void
    error: string
    mutate: (action: () => Promise<unknown>) => Promise<boolean>
}) {
    const { api } = useAppContext()
    const { sessions, isLoading, error: sessionsError } = useSessions(open ? api : null)
    const [search, setSearch] = useState('')
    const candidates = sessions
        .filter(session => session.active && !members.some(member => member.id === session.id))
        .filter(session =>
            [
                session.metadata?.name,
                session.metadata?.summary?.text,
                session.metadata?.path,
                session.activity?.text,
                session.id
            ].some(value => value?.toLowerCase().includes(search.toLowerCase()))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    const [busy, setBusy] = useState(false)
    const run = async (action: () => Promise<unknown>) => {
        setBusy(true)
        try {
            return await mutate(action)
        } finally {
            setBusy(false)
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <div className="flex items-center justify-between">
                    <DialogTitle>Members & settings</DialogTitle>
                    <button className={threadButton} aria-label="Close settings" onClick={() => onOpenChange(false)}>
                        ✕
                    </button>
                </div>
                <DialogDescription>{thread.description || thread.name}</DialogDescription>
                {error && (
                    <p role="alert" className="mt-2 text-sm text-red-500">
                        {error}
                    </p>
                )}
                <label className="mt-4 flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={thread.autoNotify}
                        disabled={busy || thread.archived}
                        onChange={e => void run(() => api!.threadRequest(`/${thread.id}/auto-notify`, { enabled: e.target.checked }))}
                    />{' '}
                    Notify the only session without a mention
                </label>
                <ul className="my-4 space-y-3">
                    {members.map(member => (
                        <li key={member.id} className="rounded-lg border border-[var(--app-divider)] p-3">
                            <div className="flex items-center gap-2">
                                {member.kind !== 'user' && <ThreadAvatar id={member.id} kind={member.kind} />}
                                {member.kind === 'session' ? (
                                    <Link
                                        className="truncate font-medium text-[var(--app-link)]"
                                        to="/sessions/$sessionId"
                                        params={{ sessionId: member.id }}
                                    >
                                        {memberName(member)}
                                    </Link>
                                ) : (
                                    <span className="font-medium">{memberName(member)}</span>
                                )}
                                <span className="ml-auto text-xs text-[var(--app-hint)]">{member.status}</span>
                            </div>
                            {member.summary?.text && <p className="mt-1 text-sm">{member.summary.text}</p>}
                            <p className="mt-1 break-all text-xs text-[var(--app-hint)]">
                                {member.machine} {member.path}
                            </p>
                            {member.kind === 'session' && (
                                <label className="mt-2 flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={member.mentionWake}
                                        disabled={busy || thread.archived}
                                        onChange={e =>
                                            void run(() =>
                                                api!.threadRequest(`/${thread.id}/settings`, {
                                                    sessionId: member.id,
                                                    mentionWake: e.target.checked
                                                })
                                            )
                                        }
                                    />{' '}
                                    Allow mention wakeups
                                </label>
                            )}
                        </li>
                    ))}
                </ul>
                {!thread.archived && (
                    <>
                        <section
                            aria-label="Add members"
                            className="space-y-2 border-t border-[var(--app-divider)] pt-3"
                        >
                            <h3 className="text-sm font-medium">Add members</h3>
                            <input
                                aria-label="Search sessions"
                                placeholder="Search title, summary, or directory"
                                className={threadInput}
                                value={search}
                                onChange={event => setSearch(event.target.value)}
                            />
                            {sessionsError && (
                                <p role="alert" className="text-sm text-red-500">
                                    {sessionsError}
                                </p>
                            )}
                            <div className="max-h-72 overflow-y-auto">
                                {isLoading ? (
                                    <p className="p-3 text-sm text-[var(--app-hint)]">Loading sessions…</p>
                                ) : candidates.length === 0 ? (
                                    <p className="p-3 text-sm text-[var(--app-hint)]">No available active sessions</p>
                                ) : (
                                    candidates.map(session => (
                                        <button
                                            type="button"
                                            key={session.id}
                                            disabled={busy}
                                            className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-[var(--app-subtle-bg)] disabled:opacity-40"
                                            onClick={() =>
                                                void run(() =>
                                                    api!.threadRequest(`/${thread.id}/add`, { sessionId: session.id })
                                                )
                                            }
                                        >
                                            <div className="min-w-0 flex-1">
                                                <SessionChoiceDetails session={session} />
                                            </div>
                                            <span className="shrink-0 text-sm text-[var(--app-link)]">Add</span>
                                        </button>
                                    ))
                                )}
                            </div>
                        </section>
                        <button
                            className={`${threadButton} mt-4 text-red-500`}
                            disabled={busy}
                            onClick={() =>
                                void run(() => api!.threadRequest(`/${thread.id}/archive`, {})).then(ok => {
                                    if (ok) onOpenChange(false)
                                })
                            }
                        >
                            Archive thread
                        </button>
                    </>
                )}
                <details className="mt-4 text-xs text-[var(--app-hint)]">
                    <summary>Thread details</summary>
                    <p className="mt-2 break-all">{thread.id}</p>
                </details>
            </DialogContent>
        </Dialog>
    )
}
