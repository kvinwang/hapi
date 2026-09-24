import { useState } from 'react'
import { compatibleCredentialAgents, type CredentialAgent } from '@hapi/protocol'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCredentials } from '@/hooks/queries/useCredentials'
import { useMachines } from '@/hooks/queries/useMachines'
import { useApplyCredentials, useDeleteCredential } from '@/hooks/mutations/useCredentialActions'
import type { Credential } from '@/types/api'
import {
    AGENT_LABELS,
    CredentialForm,
    inputClass,
    primaryButtonClass,
    type CredentialFormSeed
} from './CredentialForm'

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

function DuplicateIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

function UploadIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
    )
}

const iconButtonBase = 'flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]'
const iconButtonClass = `${iconButtonBase} hover:text-[var(--app-fg)]`

function ApplyPanel(props: { credential: Credential; machines: Array<{ id: string; label: string }>; apply: ReturnType<typeof useApplyCredentials> }) {
    const agents = compatibleCredentialAgents(props.credential.config)
    const [machineId, setMachineId] = useState('')
    const [agent, setAgent] = useState<CredentialAgent | undefined>(agents[0])
    const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
    const run = async () => {
        if (!agent) return
        setStatus(null)
        try {
            const result = await props.apply.mutateAsync({ machineId, credentialId: props.credential.id, agent })
            setStatus(result.success
                ? { ok: true, message: `Applied to ${AGENT_LABELS[agent]}: ${result.written?.join(', ') ?? 'done'}` }
                : { ok: false, message: result.error ?? 'Failed' })
        } catch (e) {
            setStatus({ ok: false, message: e instanceof Error ? e.message : 'Failed' })
        }
    }
    return (
        <div className="px-3 pb-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <select className={`${inputClass} flex-1`} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                    <option value="">Select machine...</option>
                    {props.machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.label}</option>)}
                </select>
                <select className={inputClass} aria-label="Apply to agent" value={agent ?? ''}
                    onChange={(e) => setAgent(e.target.value as CredentialAgent)}>
                    {agents.map((item) => <option key={item} value={item}>Apply to {AGENT_LABELS[item]}</option>)}
                </select>
                <button type="button" className={primaryButtonClass} onClick={run}
                    disabled={!machineId || !agent || props.apply.isPending}>
                    {props.apply.isPending ? 'Applying...' : 'Apply'}
                </button>
            </div>
            {status && <div className={`text-xs ${status.ok ? 'text-green-500' : 'text-red-500'}`}>{status.message}</div>}
        </div>
    )
}

export default function CredentialsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { credentials, isLoading } = useCredentials(api, true)
    const { machines } = useMachines(api, true)
    const deleteMutation = useDeleteCredential(api)
    const applyMutation = useApplyCredentials(api)
    const [form, setForm] = useState<(CredentialFormSeed & { key: number }) | null>(null)
    const [applyId, setApplyId] = useState<string | null>(null)
    const onlineMachines = machines.filter((machine) => machine.active)
    const machineOptions = onlineMachines.map((machine) => ({
        id: machine.id,
        label: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id
    }))

    const openForm = (seed: CredentialFormSeed) => setForm({ ...seed, key: Date.now() })

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
                    <div className="flex-1 font-semibold">Credentials</div>
                    <button
                        type="button"
                        onClick={() => openForm({ name: '' })}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title="Add credential"
                    >
                        <PlusIcon />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {form && (
                        <CredentialForm key={form.key} api={api} seed={form} machines={onlineMachines} onClose={() => setForm(null)} />
                    )}

                    {isLoading && <div className="px-3 py-8 text-center text-[var(--app-hint)]">Loading...</div>}
                    {!isLoading && credentials.length === 0 && (
                        <div className="px-3 py-4 text-sm text-[var(--app-hint)]">No credentials configured</div>
                    )}

                    {credentials.map((credential) => {
                        const agents = compatibleCredentialAgents(credential.config)
                        const { config } = credential
                        return (
                            <div key={credential.id} className="border-b border-[var(--app-divider)]">
                                <div className="flex items-center justify-between px-3 py-3 transition-colors hover:bg-[var(--app-subtle-bg)]">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[var(--app-fg)] font-medium truncate">{credential.name}</div>
                                        <div className="text-xs text-[var(--app-hint)] truncate mt-0.5">
                                            {config.provider} · {config.defaultModel}
                                            {config.models.length > 1 ? ` +${config.models.length - 1} models` : ''}
                                            {' · '}{agents.map((agent) => AGENT_LABELS[agent]).join(', ')}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 ml-2 shrink-0">
                                        {onlineMachines.length > 0 && agents.length > 0 && (
                                            <button type="button" className={iconButtonClass} title="Apply to machine"
                                                onClick={() => setApplyId(applyId === credential.id ? null : credential.id)}>
                                                <UploadIcon />
                                            </button>
                                        )}
                                        <button type="button" className={iconButtonClass} title="Duplicate"
                                            onClick={() => openForm({ name: `${credential.name} (copy)`, config })}>
                                            <DuplicateIcon />
                                        </button>
                                        <button type="button" className={iconButtonClass} title="Edit"
                                            onClick={() => openForm({ id: credential.id, name: credential.name, config })}>
                                            <EditIcon />
                                        </button>
                                        <button type="button" className={`${iconButtonBase} hover:text-red-500`} title="Delete"
                                            onClick={() => deleteMutation.mutate(credential.id)}>
                                            <TrashIcon />
                                        </button>
                                    </div>
                                </div>
                                {applyId === credential.id && (
                                    <ApplyPanel credential={credential} machines={machineOptions} apply={applyMutation} />
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
