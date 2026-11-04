import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Group, GroupInbox, GroupMember } from '@hapi/protocol/groups'
import { useAppContext } from '@/lib/app-context'
import { useSessions } from '@/hooks/queries/useSessions'

type Member = GroupMember & {
    title?: string
    summary?: { text: string }
    machine?: string
    path?: string
    status: string
}
const button = 'rounded border border-[var(--app-divider)] px-3 py-2 disabled:opacity-40'
const input = 'rounded border border-[var(--app-divider)] bg-[var(--app-bg)] p-2'

export default function GroupsPage() {
    const { api } = useAppContext()
    const client = useQueryClient()
    const sendAttempt = useRef<{ key: string; id: string } | null>(null)
    const [selected, setSelected] = useState('')
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [text, setText] = useState('')
    const [mentions, setMentions] = useState<string[]>([])
    const [target, setTarget] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [replyTo, setReplyTo] = useState<string>()
    const [before, setBefore] = useState<number>()
    const { sessions } = useSessions(api)
    const groups = useQuery({
        queryKey: ['groups'],
        queryFn: () => api!.groupRequest<{ groups: Array<Group & { unread: number }> }>(''),
        enabled: !!api,
        refetchInterval: 30_000
    })
    const info = useQuery({
        queryKey: ['groups', selected],
        queryFn: () => api!.groupRequest<{ group: Group; members: Member[] }>(`/${selected}`),
        enabled: !!api && !!selected,
        refetchInterval: 30_000
    })
    const visible = useQuery({
        queryKey: ['groups', selected, 'history', before],
        queryFn: () =>
            api!.groupRequest<GroupInbox>(`/${selected}/history?limit=50${before ? `&before=${before}` : ''}`),
        enabled: !!api && !!selected,
        refetchInterval: 30_000
    })
    const group = info.data?.group
    useEffect(() => {
        setBefore(undefined)
        setMentions([])
        setReplyTo(undefined)
        setText('')
        setTarget('')
        setError('')
    }, [selected])
    useEffect(() => {
        const ids = visible.data?.messages
            .filter(m => m.receipts.some(r => r.memberId === 'user' && !r.readAt))
            .map(m => m.id)
        if (!api || !ids?.length) return
        const consumeVisible = () => {
            if (document.visibilityState !== 'visible') return
            void api
                .groupRequest('/consume', { ids })
                .then(() => client.invalidateQueries({ queryKey: ['groups'] }))
                .catch(e => setError(String(e)))
        }
        consumeVisible()
        document.addEventListener('visibilitychange', consumeVisible)
        return () => document.removeEventListener('visibilitychange', consumeVisible)
    }, [api, visible.data, client])
    async function act(action: () => Promise<unknown>) {
        setBusy(true)
        setError('')
        try {
            await action()
            await client.invalidateQueries({ queryKey: ['groups'] })
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }
    if (!api) return <p className="p-4">Sign in to view groups.</p>
    return (
        <main className="mx-auto w-full max-w-4xl space-y-4 overflow-y-auto p-4">
            <header className="flex items-center justify-between">
                <h1 className="text-xl font-semibold">Groups</h1>
                <Link to="/sessions">Sessions</Link>
            </header>
            {(error || groups.error || info.error || visible.error) && (
                <p role="alert" className="text-red-500">
                    {error || String(groups.error || info.error || visible.error)}
                </p>
            )}
            <form
                className="flex flex-wrap gap-2"
                onSubmit={e => {
                    e.preventDefault()
                    void act(async () => {
                        const result = await api.groupRequest<{ group: Group }>('', { name, description })
                        setSelected(result.group.id)
                        setName('')
                        setDescription('')
                    })
                }}
            >
                <input
                    aria-label="Group name"
                    placeholder="Group name"
                    className={input}
                    value={name}
                    onChange={e => setName(e.target.value)}
                    required
                    maxLength={120}
                />
                <input
                    aria-label="Purpose"
                    placeholder="Purpose"
                    className={`${input} flex-1`}
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    maxLength={2000}
                />
                <button className={button} disabled={busy}>
                    Create group
                </button>
            </form>
            <nav className="flex flex-wrap gap-2">
                {groups.data?.groups.map(g => (
                    <button
                        key={g.id}
                        className={`${button} ${selected === g.id ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                        disabled={busy}
                        onClick={() => setSelected(g.id)}
                    >
                        {g.name} {g.archived ? '(archived)' : `(${g.unread})`}
                    </button>
                ))}
            </nav>
            {group && (
                <>
                    <header className="space-y-1">
                        <h2 className="text-lg font-semibold">{group.name}</h2>
                        <p>{group.description}</p>
                        <p className="break-all text-xs text-[var(--app-hint)]">{group.id}</p>
                    </header>
                    {group.wakeCount >= group.wakeLimit && (
                        <p role="status" className="rounded bg-[var(--app-subtle-bg)] p-3">
                            Automatic wake limit reached ({group.wakeLimit}). New mentions stay unread. A human message
                            resets the budget.
                        </p>
                    )}
                    <details>
                        <summary className="cursor-pointer">Members ({info.data?.members.length})</summary>
                        <ul className="space-y-2 py-2">
                            {info.data?.members.map(m => (
                                <li key={m.id} className="rounded border border-[var(--app-divider)] p-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span>
                                            {m.title ?? m.id} · {m.status}
                                        </span>
                                        {m.kind === 'session' && (
                                            <label>
                                                <input
                                                    type="checkbox"
                                                    checked={m.mentionWake}
                                                    disabled={busy || group.archived}
                                                    onChange={e =>
                                                        void act(() =>
                                                            api.groupRequest(`/${selected}/settings`, {
                                                                sessionId: m.id,
                                                                mentionWake: e.target.checked
                                                            })
                                                        )
                                                    }
                                                />{' '}
                                                Mention wake
                                            </label>
                                        )}
                                    </div>
                                    <p className="break-all text-xs text-[var(--app-hint)]">
                                        {m.id} {m.machine} {m.path}
                                    </p>
                                    {m.summary?.text && <p className="text-sm">{m.summary.text}</p>}
                                </li>
                            ))}
                        </ul>
                        {!group.archived && (
                            <form
                                className="flex gap-2"
                                onSubmit={e => {
                                    e.preventDefault()
                                    void act(() =>
                                        api.groupRequest(`/${selected}/add`, {
                                            sessionId: target
                                        })
                                    )
                                }}
                            >
                                <select
                                    aria-label="Add session"
                                    className={`${input} min-w-0 flex-1`}
                                    value={target}
                                    onChange={e => setTarget(e.target.value)}
                                    required
                                >
                                    <option value="">Select a session</option>
                                    {sessions
                                        .filter(s => !info.data?.members.some(m => m.id === s.id))
                                        .map(s => (
                                            <option key={s.id} value={s.id}>
                                                {s.metadata?.name ?? s.id}
                                            </option>
                                        ))}
                                </select>
                                <button className={button} disabled={busy}>
                                    Add
                                </button>
                            </form>
                        )}
                    </details>
                    <section aria-label="Group messages" className="space-y-3">
                        {visible.data?.messages.map(m => (
                            <article key={m.id} className="rounded border border-[var(--app-divider)] p-3">
                                <div className="break-all text-xs text-[var(--app-hint)]">
                                    #{m.seq} · {m.sender.kind === 'user' ? 'You' : `Session ${m.sender.sessionId}`} ·{' '}
                                    {new Date(m.createdAt).toLocaleString()}
                                </div>
                                {m.replyTo && <div className="break-all text-xs">Reply to {m.replyTo}</div>}
                                <p className="whitespace-pre-wrap break-words py-2">{m.text}</p>
                                {!!m.mentions.length && (
                                    <p className="break-all text-xs">Mentions: {m.mentions.join(', ')}</p>
                                )}
                                <div className="text-xs text-[var(--app-hint)]">
                                    Saved
                                    {m.receipts.map(r => (
                                        <div key={r.memberId} className="break-all">
                                            {r.memberId}: {r.readAt ? 'Read' : r.deliveredAt ? 'Delivered' : 'Saved'}
                                            {r.wakeStatus
                                                ? ` · ${r.wakeStatus}${r.reason ? ` (${r.reason})` : ''}`
                                                : ''}
                                        </div>
                                    ))}
                                </div>
                                {!group.archived && (
                                    <button
                                        className="mt-2 text-sm text-[var(--app-link)]"
                                        onClick={() => setReplyTo(m.id)}
                                    >
                                        Reply
                                    </button>
                                )}
                            </article>
                        ))}
                    </section>
                    <div className="flex gap-2">
                        {before && (
                            <button className={button} onClick={() => setBefore(undefined)}>
                                Latest messages
                            </button>
                        )}
                        {visible.data?.hasMore && (
                            <button className={button} onClick={() => setBefore(visible.data!.messages[0].seq)}>
                                Older messages
                            </button>
                        )}
                    </div>
                    {!group.archived && (
                        <form
                            className="space-y-2"
                            onSubmit={e => {
                                e.preventDefault()
                                void act(async () => {
                                    const key = JSON.stringify([selected, text, mentions, replyTo])
                                    if (sendAttempt.current?.key !== key)
                                        sendAttempt.current = { key, id: crypto.randomUUID() }
                                    await api.groupRequest(`/${selected}/send`, {
                                        text,
                                        mentions,
                                        replyTo,
                                        clientMessageId: sendAttempt.current.id
                                    })
                                    sendAttempt.current = null
                                    setText('')
                                    setMentions([])
                                    setReplyTo(undefined)
                                    setBefore(undefined)
                                })
                            }}
                        >
                            {replyTo && (
                                <button type="button" className="text-sm" onClick={() => setReplyTo(undefined)}>
                                    Replying to {replyTo} · Cancel
                                </button>
                            )}
                            <textarea
                                aria-label="Message"
                                className={`${input} w-full`}
                                placeholder="Message the group"
                                value={text}
                                onChange={e => setText(e.target.value)}
                                required
                                maxLength={32000}
                            />
                            <fieldset className="flex flex-wrap gap-3">
                                <legend className="text-sm">Mention to request action</legend>
                                {info.data?.members
                                    .filter(m => m.kind === 'session')
                                    .map(m => (
                                        <label key={m.id} className="text-sm">
                                            <input
                                                type="checkbox"
                                                checked={mentions.includes(m.id)}
                                                onChange={e =>
                                                    setMentions(previous =>
                                                        e.target.checked
                                                            ? [...previous, m.id]
                                                            : previous.filter(id => id !== m.id)
                                                    )
                                                }
                                            />{' '}
                                            {m.title ?? m.id.slice(0, 8)}
                                        </label>
                                    ))}
                            </fieldset>
                            <div className="flex justify-between">
                                <button className={button} disabled={busy}>
                                    Send
                                </button>
                                <button
                                    type="button"
                                    className={button}
                                    disabled={busy}
                                    onClick={() => void act(() => api.groupRequest(`/${selected}/archive`, {}))}
                                >
                                    Archive group
                                </button>
                            </div>
                        </form>
                    )}
                </>
            )}
        </main>
    )
}
