import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { Group } from '@hapi/protocol/groups'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'
import { groupButton, groupInput, memberName, type Member } from './types'

export function GroupMembers({
    group,
    members,
    open,
    onOpenChange,
    mutate,
    error
}: {
    group: Group
    members: Member[]
    open: boolean
    onOpenChange: (open: boolean) => void
    error: string
    mutate: (action: () => Promise<unknown>) => Promise<boolean>
}) {
    const { api } = useAppContext()
    const { sessions } = useSessions(open ? api : null)
    const [target, setTarget] = useState('')
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
                    <button className={groupButton} aria-label="Close settings" onClick={() => onOpenChange(false)}>
                        ✕
                    </button>
                </div>
                <DialogDescription>{group.description || group.name}</DialogDescription>
                {error && (
                    <p role="alert" className="mt-2 text-sm text-red-500">
                        {error}
                    </p>
                )}
                <ul className="my-4 space-y-3">
                    {members.map(member => (
                        <li key={member.id} className="rounded-lg border border-[var(--app-divider)] p-3">
                            <div className="flex items-center justify-between gap-2">
                                {member.kind === 'session' ? (
                                    <Link
                                        className="truncate font-medium text-[var(--app-link)]"
                                        to="/sessions/$sessionId"
                                        params={{ sessionId: member.id }}
                                    >
                                        {memberName(member)}
                                    </Link>
                                ) : (
                                    <span className="font-medium">You</span>
                                )}
                                <span className="text-xs text-[var(--app-hint)]">{member.status}</span>
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
                                        disabled={busy || group.archived}
                                        onChange={e =>
                                            void run(() =>
                                                api!.groupRequest(`/${group.id}/settings`, {
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
                {!group.archived && (
                    <>
                        <form
                            className="flex gap-2"
                            onSubmit={e => {
                                e.preventDefault()
                                void run(() => api!.groupRequest(`/${group.id}/add`, { sessionId: target })).then(
                                    ok => {
                                        if (ok) setTarget('')
                                    }
                                )
                            }}
                        >
                            <select
                                aria-label="Add session"
                                className={`${groupInput} min-w-0 flex-1`}
                                value={target}
                                onChange={e => setTarget(e.target.value)}
                                required
                                disabled={busy}
                            >
                                <option value="">Select a session</option>
                                {sessions
                                    .filter(session => !members.some(member => member.id === session.id))
                                    .map(session => (
                                        <option key={session.id} value={session.id}>
                                            {session.metadata?.name ?? session.id}
                                        </option>
                                    ))}
                            </select>
                            <button className={groupButton} disabled={busy || !target}>
                                Add
                            </button>
                        </form>
                        <button
                            className={`${groupButton} mt-4 text-red-500`}
                            disabled={busy}
                            onClick={() =>
                                void run(() => api!.groupRequest(`/${group.id}/archive`, {})).then(ok => {
                                    if (ok) onOpenChange(false)
                                })
                            }
                        >
                            Archive group
                        </button>
                    </>
                )}
                <details className="mt-4 text-xs text-[var(--app-hint)]">
                    <summary>Group details</summary>
                    <p className="mt-2 break-all">{group.id}</p>
                    <p>
                        Automatic wakeups: {group.wakeCount}/{group.wakeLimit}
                    </p>
                </details>
            </DialogContent>
        </Dialog>
    )
}
