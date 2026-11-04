import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group } from '@hapi/protocol/groups'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { groupButton, groupInput } from '@/components/Groups/types'
import { useAppContext } from '@/lib/app-context'

export default function GroupsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const client = useQueryClient()
    const [creating, setCreating] = useState(false)
    const [showArchived, setShowArchived] = useState(false)
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const groups = useQuery({
        queryKey: ['groups'],
        queryFn: () => api!.groupRequest<{ groups: Array<Group & { unread: number }> }>(''),
        enabled: !!api,
        refetchInterval: 30_000
    })
    const visible = groups.data?.groups.filter(group => showArchived || !group.archived) ?? []
    if (!api) return <p className="p-4">Sign in to view groups.</p>
    return (
        <main className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="flex shrink-0 items-center gap-3 border-b border-[var(--app-divider)] px-4 py-3">
                <Link to="/sessions" className={groupButton} aria-label="Back to sessions">
                    ←
                </Link>
                <h1 className="flex-1 text-lg font-semibold">Groups</h1>
                <button className={groupButton} onClick={() => setCreating(true)}>
                    ＋ New group
                </button>
            </header>
            <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4">
                <label className="mb-4 flex items-center gap-2 text-sm text-[var(--app-hint)]">
                    <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{' '}
                    Show archived
                </label>
                {groups.error && <p role="alert">{groups.error.message}</p>}
                {groups.isPending ? (
                    <p className="p-8 text-center text-[var(--app-hint)]">Loading groups…</p>
                ) : !visible.length ? (
                    <div className="py-20 text-center">
                        <h2 className="text-lg font-medium">A shared space for your agents</h2>
                        <p className="mt-2 text-[var(--app-hint)]">
                            Create a group to discuss work and bring sessions together.
                        </p>
                        <button
                            className={`${groupButton} mt-4 text-[var(--app-link)]`}
                            onClick={() => setCreating(true)}
                        >
                            Create group
                        </button>
                    </div>
                ) : (
                    <nav aria-label="Groups" className="space-y-2">
                        {visible.map(group => (
                            <Link
                                key={group.id}
                                to="/groups/$groupId"
                                params={{ groupId: group.id }}
                                className="flex items-center gap-3 rounded-xl p-4 hover:bg-[var(--app-subtle-bg)]"
                            >
                                <span
                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-lg"
                                    aria-hidden="true"
                                >
                                    #
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold">
                                        {group.name}
                                        {group.archived && (
                                            <span className="ml-2 text-xs font-normal text-[var(--app-hint)]">
                                                Archived
                                            </span>
                                        )}
                                    </div>
                                    <p className="truncate text-sm text-[var(--app-hint)]">
                                        {group.description || 'Open conversation'}
                                    </p>
                                </div>
                                {group.unread > 0 && (
                                    <span
                                        aria-label={`${group.unread} unread`}
                                        className="rounded-full bg-[var(--app-link)] px-2 py-0.5 text-xs text-white"
                                    >
                                        {group.unread}
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
                    <DialogTitle>New group</DialogTitle>
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
                                .groupRequest<{ group: Group }>('', { name, description })
                                .then(async result => {
                                    await client.invalidateQueries({ queryKey: ['groups'] })
                                    setCreating(false)
                                    await navigate({ to: '/groups/$groupId', params: { groupId: result.group.id } })
                                })
                                .catch(e => setError(String(e)))
                                .finally(() => setBusy(false))
                        }}
                    >
                        <input
                            aria-label="Group name"
                            autoFocus
                            placeholder="Group name"
                            className={groupInput}
                            value={name}
                            onChange={e => setName(e.target.value)}
                            required
                            maxLength={120}
                            disabled={busy}
                        />
                        <textarea
                            aria-label="Purpose"
                            placeholder="What is this group working on?"
                            className={groupInput}
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
                                className={groupButton}
                                onClick={() => setCreating(false)}
                                disabled={busy}
                            >
                                Cancel
                            </button>
                            <button className={`${groupButton} text-[var(--app-link)]`} disabled={busy || !name.trim()}>
                                Create group
                            </button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </main>
    )
}
