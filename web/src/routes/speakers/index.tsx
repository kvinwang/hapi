import { useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useSpeakers } from '@/hooks/queries/useSpeakers'
import { useCreateSpeaker, useUpdateSpeaker, useDeleteSpeaker } from '@/hooks/mutations/useSpeakerActions'
import type { Speaker } from '@/types/api'

function BackIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function PlusIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function TrashIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

function EditIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

const inputClass = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"

export default function SpeakersPage() {
    const goBack = useAppGoBack()
    const { api } = useAppContext()
    const { speakers, isLoading } = useSpeakers(api)
    const createSpeaker = useCreateSpeaker(api)
    const updateSpeaker = useUpdateSpeaker(api)
    const deleteSpeaker = useDeleteSpeaker(api)

    const [showAdd, setShowAdd] = useState(false)
    const [newId, setNewId] = useState('')
    const [newName, setNewName] = useState('')
    const [newSessionId, setNewSessionId] = useState('')
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editName, setEditName] = useState('')
    const [editSessionId, setEditSessionId] = useState('')
    const [error, setError] = useState<string | null>(null)

    const handleAdd = async () => {
        if (!newId.trim() || !newName.trim()) return
        setError(null)
        try {
            await createSpeaker.mutateAsync({
                id: newId.trim(),
                name: newName.trim(),
                sessionId: newSessionId.trim() || undefined
            })
            setNewId('')
            setNewName('')
            setNewSessionId('')
            setShowAdd(false)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to create speaker')
        }
    }

    const handleSaveEdit = async (speaker: Speaker) => {
        setError(null)
        try {
            await updateSpeaker.mutateAsync({
                id: speaker.id,
                name: editName.trim() || undefined,
                sessionId: editSessionId.trim() || null
            })
            setEditingId(null)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to update speaker')
        }
    }

    const handleDelete = async (id: string) => {
        setError(null)
        try {
            await deleteSpeaker.mutateAsync(id)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to delete speaker')
        }
    }

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="flex-1 font-semibold">Speakers</div>
                    <button
                        type="button"
                        onClick={() => setShowAdd(!showAdd)}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <PlusIcon />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {error && (
                        <div className="mx-3 mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
                            {error}
                        </div>
                    )}

                    {/* Add form */}
                    {showAdd && (
                        <div className="border-b border-[var(--app-divider)] p-3">
                            <div className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">
                                Add Speaker
                            </div>
                            <div className="flex flex-col gap-2">
                                <input type="text" placeholder="Device ID" value={newId}
                                    onChange={(e) => setNewId(e.target.value)} className={inputClass} />
                                <input type="text" placeholder="Name" value={newName}
                                    onChange={(e) => setNewName(e.target.value)} className={inputClass} />
                                <input type="text" placeholder="Session ID (optional)" value={newSessionId}
                                    onChange={(e) => setNewSessionId(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
                                    className={inputClass} />
                                <div className="flex justify-end gap-2">
                                    <button type="button"
                                        onClick={() => { setShowAdd(false); setNewId(''); setNewName(''); setNewSessionId('') }}
                                        className="rounded-lg px-3 py-1.5 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
                                        Cancel
                                    </button>
                                    <button type="button"
                                        onClick={() => void handleAdd()}
                                        disabled={!newId.trim() || !newName.trim() || createSpeaker.isPending}
                                        className="rounded-lg px-4 py-1.5 text-sm font-medium bg-[var(--app-link)] text-white hover:opacity-90 transition-colors disabled:opacity-50">
                                        {createSpeaker.isPending ? 'Adding...' : 'Add'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Speaker list */}
                    {isLoading ? (
                        <div className="p-6 text-center text-[var(--app-hint)]">Loading...</div>
                    ) : speakers.length === 0 ? (
                        <div className="p-6 text-center text-[var(--app-hint)]">
                            No speakers registered. Add one to get started.
                        </div>
                    ) : (
                        speakers.map((speaker) => (
                            <div key={speaker.id} className="border-b border-[var(--app-divider)] px-3 py-3">
                                {editingId === speaker.id ? (
                                    <div className="flex flex-col gap-2">
                                        <input type="text" placeholder="Name" value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className={inputClass} autoFocus />
                                        <input type="text" placeholder="Session ID" value={editSessionId}
                                            onChange={(e) => setEditSessionId(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') void handleSaveEdit(speaker)
                                                if (e.key === 'Escape') setEditingId(null)
                                            }}
                                            className={inputClass} />
                                        <div className="flex justify-end gap-2">
                                            <button type="button" onClick={() => setEditingId(null)}
                                                className="rounded-lg px-3 py-1.5 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
                                                Cancel
                                            </button>
                                            <button type="button" onClick={() => void handleSaveEdit(speaker)}
                                                className="rounded-lg px-4 py-1.5 text-sm font-medium bg-[var(--app-link)] text-white hover:opacity-90 transition-colors disabled:opacity-50">
                                                Save
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-between">
                                        <div className="flex-1 min-w-0">
                                            <div className="font-medium text-[var(--app-fg)] truncate">{speaker.name}</div>
                                            <div className="text-xs text-[var(--app-hint)] font-mono truncate">{speaker.id}</div>
                                            <div className="text-xs text-[var(--app-hint)] font-mono truncate mt-0.5">
                                                {speaker.sessionId
                                                    ? <>session: {speaker.sessionId}</>
                                                    : <span className="italic">no session</span>}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 ml-2 shrink-0">
                                            <button type="button"
                                                onClick={() => { setEditingId(speaker.id); setEditName(speaker.name); setEditSessionId(speaker.sessionId ?? '') }}
                                                className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                                title="Edit">
                                                <EditIcon />
                                            </button>
                                            <button type="button"
                                                onClick={() => void handleDelete(speaker.id)}
                                                className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:bg-red-500/10 hover:text-red-500"
                                                title="Delete">
                                                <TrashIcon />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
