import { useState, useRef, useEffect } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useManagedMachines } from '@/hooks/queries/useMachines'
import { useUnbindMachine, useDeleteMachine, useUpdateMachineNotes } from '@/hooks/mutations/useMachineActions'
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

function EditIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
    )
}

function TrashIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

function MachineRow(props: {
    machine: ManagedMachine
    onUnbind: (id: string) => void
    unbinding: boolean
    onDelete: (id: string) => void
    deleting: boolean
    onUpdateNotes: (id: string, notes: string | null) => void
    updatingNotes: boolean
}) {
    const { machine, onUnbind, unbinding, onDelete, deleting, onUpdateNotes, updatingNotes } = props
    const [confirmUnbind, setConfirmUnbind] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [editingNotes, setEditingNotes] = useState(false)
    const [notesValue, setNotesValue] = useState(machine.notes ?? '')
    const notesInputRef = useRef<HTMLInputElement>(null)
    const displayName = machine.metadata?.displayName || machine.id
    const host = machine.metadata?.host ?? '—'
    const platform = machine.metadata?.platform ?? '—'

    useEffect(() => {
        if (editingNotes && notesInputRef.current) {
            notesInputRef.current.focus()
        }
    }, [editingNotes])

    const handleNotesSave = () => {
        const trimmed = notesValue.trim()
        onUpdateNotes(machine.id, trimmed || null)
        setEditingNotes(false)
    }

    const handleNotesKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleNotesSave()
        } else if (e.key === 'Escape') {
            setNotesValue(machine.notes ?? '')
            setEditingNotes(false)
        }
    }

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

            {/* Notes */}
            <div className="mt-1.5">
                {editingNotes ? (
                    <div className="flex items-center gap-1">
                        <input
                            ref={notesInputRef}
                            type="text"
                            value={notesValue}
                            onChange={(e) => setNotesValue(e.target.value)}
                            onKeyDown={handleNotesKeyDown}
                            onBlur={handleNotesSave}
                            disabled={updatingNotes}
                            placeholder="Add a note..."
                            className="flex-1 text-xs px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] text-[var(--app-fg)] border border-[var(--app-divider)] outline-none focus:border-blue-400"
                        />
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => {
                            setNotesValue(machine.notes ?? '')
                            setEditingNotes(true)
                        }}
                        className="flex items-center gap-1 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] group"
                        title="Edit notes"
                    >
                        {machine.notes ? (
                            <span className="italic">{machine.notes}</span>
                        ) : (
                            <span className="opacity-50">Add note...</span>
                        )}
                        <span className="opacity-0 group-hover:opacity-100 transition-opacity"><EditIcon /></span>
                    </button>
                )}
            </div>

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
                <div className="flex items-center gap-2">
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
                    {!machine.active && (
                        <div>
                            {confirmDelete ? (
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onDelete(machine.id)
                                            setConfirmDelete(false)
                                        }}
                                        disabled={deleting}
                                        className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                                    >
                                        {deleting ? 'Deleting...' : 'Confirm'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirmDelete(false)}
                                        className="text-[10px] px-2 py-0.5 rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setConfirmDelete(true)}
                                    className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-red-400"
                                    title="Delete machine"
                                >
                                    <TrashIcon />
                                    Delete
                                </button>
                            )}
                        </div>
                    )}
                </div>
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
    const deleteMutation = useDeleteMachine(api)
    const notesMutation = useUpdateMachineNotes(api)

    const online = machines.filter((m) => m.active)
    const offline = machines.filter((m) => !m.active)

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)]">
            {/* Header */}
            <div className="border-b border-[var(--app-divider)]">
                <div className="mx-auto w-full max-w-content flex items-center justify-between px-3 py-2">
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
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-content">
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
                                onDelete={(id) => deleteMutation.mutate(id)}
                                deleting={deleteMutation.isPending}
                                onUpdateNotes={(id, notes) => notesMutation.mutate({ machineId: id, notes })}
                                updatingNotes={notesMutation.isPending}
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
                                onDelete={(id) => deleteMutation.mutate(id)}
                                deleting={deleteMutation.isPending}
                                onUpdateNotes={(id, notes) => notesMutation.mutate({ machineId: id, notes })}
                                updatingNotes={notesMutation.isPending}
                            />
                        ))}
                    </div>
                )}
            </div>
            </div>
        </div>
    )
}
