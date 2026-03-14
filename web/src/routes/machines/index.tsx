import { useState, useCallback } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useManagedMachines } from '@/hooks/queries/useMachines'
import { useUnbindMachine } from '@/hooks/mutations/useMachineActions'
import type { ManagedMachine } from '@/types/api'

function BackIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function UnlinkIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 00-7.07-7.07l-1.71 1.71" />
            <path d="M5.17 11.75l-1.71 1.71a5.004 5.004 0 007.07 7.07l1.71-1.71" />
            <line x1="8" y1="2" x2="8" y2="5" />
            <line x1="2" y1="8" x2="5" y2="8" />
            <line x1="16" y1="19" x2="16" y2="22" />
            <line x1="19" y1="16" x2="22" y2="16" />
        </svg>
    )
}

function formatTime(ts: number): string {
    const now = Date.now()
    const diff = now - ts

    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
    if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`

    const d = new Date(ts)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
}

function MachineRow(props: {
    machine: ManagedMachine
    onUnbind: (id: string) => void
    unbinding: boolean
}) {
    const { machine, onUnbind, unbinding } = props
    const [confirmUnbind, setConfirmUnbind] = useState(false)
    const displayName = machine.metadata?.displayName || machine.id
    const host = machine.metadata?.host ?? '—'
    const platform = machine.metadata?.platform ?? '—'

    return (
        <div className="border-b border-[var(--app-divider)] px-3 py-3">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span
                        className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${machine.active ? 'bg-green-400' : 'bg-[var(--app-hint)]'}`}
                        title={machine.active ? 'Online' : 'Offline'}
                    />
                    <span className="text-sm font-medium text-[var(--app-fg)] truncate" title={machine.id}>
                        {displayName}
                    </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                    {machine.active && (
                        <span className="text-[10px] text-green-400 font-medium">ONLINE</span>
                    )}
                </div>
            </div>

            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--app-hint)]">
                <span title="Host">{host}</span>
                <span title="Platform">{platform}</span>
                {machine.metadata?.happyCliVersion && (
                    <span title="CLI Version">{machine.metadata.happyCliVersion}</span>
                )}
                {machine.active && machine.activeAt > 0 && (
                    <span title="Last active">active {formatTime(machine.activeAt)}</span>
                )}
                {!machine.active && machine.activeAt > 0 && (
                    <span title="Last seen">last seen {formatTime(machine.activeAt)}</span>
                )}
            </div>

            {displayName !== machine.id && (
                <div className="mt-1 text-[10px] text-[var(--app-hint)] font-mono truncate" title={machine.id}>
                    {machine.id}
                </div>
            )}

            <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                    {machine.apiKeyId ? (
                        <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/15 text-blue-400" title={`API Key ID: ${machine.apiKeyId}`}>
                            {machine.apiKeyName ?? machine.apiKeyId.slice(0, 8)}
                        </span>
                    ) : (
                        <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                            unbound
                        </span>
                    )}
                    <span className="text-[10px] text-[var(--app-hint)]">
                        created {formatTime(machine.createdAt)}
                    </span>
                </div>
                {machine.apiKeyId && (
                    <div>
                        {confirmUnbind ? (
                            <div className="flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => {
                                        onUnbind(machine.id)
                                        setConfirmUnbind(false)
                                    }}
                                    disabled={unbinding}
                                    className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                                >
                                    {unbinding ? 'Unbinding...' : 'Confirm'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setConfirmUnbind(false)}
                                    className="text-[10px] px-2 py-0.5 rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                                >
                                    Cancel
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirmUnbind(true)}
                                className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                title="Unbind API key"
                            >
                                <UnlinkIcon />
                                Unbind
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

function InvitePanel(props: { api: ReturnType<typeof useAppContext>['api'] }) {
    const [inviteData, setInviteData] = useState<{ command: string; expiresAt: number } | null>(null)
    const [creating, setCreating] = useState(false)
    const [copied, setCopied] = useState(false)

    const handleCreate = useCallback(async () => {
        setCreating(true)
        try {
            const result = await props.api.createInvite()
            setInviteData({ command: result.command, expiresAt: result.expiresAt })
        } catch {
            // ignore
        } finally {
            setCreating(false)
        }
    }, [props.api])

    const handleCopy = useCallback(() => {
        if (!inviteData) return
        navigator.clipboard.writeText(inviteData.command)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [inviteData])

    if (!inviteData) {
        return (
            <div className="px-3 py-3 border-b border-[var(--app-divider)]">
                <button
                    type="button"
                    onClick={handleCreate}
                    disabled={creating}
                    className="w-full rounded-lg px-4 py-2 text-sm font-medium bg-[var(--app-link)] text-white hover:opacity-90 transition-colors disabled:opacity-50"
                >
                    {creating ? 'Creating...' : 'Invite Remote Machine'}
                </button>
            </div>
        )
    }

    return (
        <div className="px-3 py-3 border-b border-[var(--app-divider)]">
            <div className="text-xs font-semibold text-[var(--app-hint)] mb-2">
                Send this command to the remote user:
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2">
                <code className="flex-1 text-xs text-[var(--app-fg)] break-all select-all">
                    {inviteData.command}
                </code>
                <button
                    type="button"
                    onClick={handleCopy}
                    className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    title="Copy"
                >
                    {copied ? <span className="text-[10px] text-[var(--app-link)]">Copied</span> : <CopyIcon />}
                </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[10px] text-[var(--app-hint)]">
                    Expires {new Date(inviteData.expiresAt).toLocaleTimeString()}
                </span>
                <button
                    type="button"
                    onClick={() => setInviteData(null)}
                    className="text-[10px] text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                >
                    Done
                </button>
            </div>
        </div>
    )
}

function CopyIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

export default function MachinesPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { machines, isLoading, error } = useManagedMachines(api)
    const unbindMutation = useUnbindMachine(api)

    const online = machines.filter((m) => m.active)
    const offline = machines.filter((m) => !m.active)

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)]">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--app-divider)] px-3 py-2">
                <div className="flex items-center gap-2">
                    <button type="button" onClick={goBack} className="text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                        <BackIcon />
                    </button>
                    <h1 className="text-base font-semibold text-[var(--app-fg)]">Machines</h1>
                </div>
                <span className="text-xs text-[var(--app-hint)]">
                    {machines.length} total
                </span>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                <InvitePanel api={api} />

                {isLoading && (
                    <div className="flex items-center justify-center py-12 text-sm text-[var(--app-hint)]">
                        Loading...
                    </div>
                )}

                {error && (
                    <div className="px-3 py-3 text-sm text-red-400">
                        {error}
                    </div>
                )}

                {!isLoading && !error && machines.length === 0 && (
                    <div className="flex items-center justify-center py-12 text-sm text-[var(--app-hint)]">
                        No machines registered
                    </div>
                )}

                {online.length > 0 && (
                    <div>
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Online ({online.length})
                        </div>
                        {online.map((m) => (
                            <MachineRow
                                key={m.id}
                                machine={m}
                                onUnbind={(id) => unbindMutation.mutate(id)}
                                unbinding={unbindMutation.isPending}
                            />
                        ))}
                    </div>
                )}

                {offline.length > 0 && (
                    <div>
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Offline ({offline.length})
                        </div>
                        {offline.map((m) => (
                            <MachineRow
                                key={m.id}
                                machine={m}
                                onUnbind={(id) => unbindMutation.mutate(id)}
                                unbinding={unbindMutation.isPending}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
