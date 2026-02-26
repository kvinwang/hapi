import { useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCredentials } from '@/hooks/queries/useCredentials'
import { useMachines } from '@/hooks/queries/useMachines'
import {
    useCreateCredential,
    useUpdateCredential,
    useDeleteCredential,
    useApplyCredentials,
    useReadMachineCredentials
} from '@/hooks/mutations/useCredentialActions'
import type { Credential, AgentType } from '@/types/api'

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

function UploadIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
    )
}

function maskToken(token: string): string {
    if (token.length <= 12) return '****'
    return `${token.slice(0, 8)}****${token.slice(-4)}`
}

function getCredentialPreview(config: unknown, agentType: string): string {
    if (!config || typeof config !== 'object') return 'Invalid config'

    const obj = config as Record<string, unknown>

    if (agentType === 'claude') {
        const parts: string[] = []
        const creds = obj.credentials as Record<string, unknown> | undefined
        if (creds?.claudeAiOauth) {
            const oauth = creds.claudeAiOauth as Record<string, unknown>
            const sub = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : 'oauth'
            const token = typeof oauth.accessToken === 'string' ? maskToken(oauth.accessToken) : ''
            parts.push(`OAuth: ${sub}${token ? ` | ${token}` : ''}`)
        }
        const settings = obj.settings as Record<string, unknown> | undefined
        const env = settings?.env as Record<string, unknown> | undefined
        if (env) {
            const apiKey = typeof env.ANTHROPIC_API_KEY === 'string' ? maskToken(env.ANTHROPIC_API_KEY) : null
            const baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : null
            if (apiKey) parts.push(`API Key: ${apiKey}`)
            else if (baseUrl) parts.push(`Custom: ${baseUrl}`)
            else parts.push('Settings env')
        }
        return parts.length > 0 ? parts.join(' + ') : 'Empty config'
    }

    if (agentType === 'codex') {
        const parts: string[] = []
        const auth = obj.auth as Record<string, unknown> | undefined
        if (auth) {
            const authMode = typeof auth.auth_mode === 'string' ? auth.auth_mode : 'unknown'
            if (authMode === 'apikey') {
                const key = typeof auth.OPENAI_API_KEY === 'string' ? maskToken(auth.OPENAI_API_KEY) : 'no key'
                parts.push(`API Key: ${key}`)
            } else {
                const tokens = auth.tokens as Record<string, unknown> | undefined
                const accountId = typeof tokens?.account_id === 'string'
                    ? tokens.account_id.slice(0, 8)
                    : 'unknown'
                parts.push(`OAuth: ${accountId}...`)
            }
        }
        if (typeof obj.config === 'string') {
            const toml = obj.config as string
            const modelMatch = toml.match(/^model\s*=\s*"(.+?)"/m)
            if (modelMatch) parts.push(`model: ${modelMatch[1]}`)
        }
        return parts.length > 0 ? parts.join(' + ') : 'Empty config'
    }

    return 'Unknown agent type'
}

/** Extract key fields + [model_providers.*] sections from Codex config.toml */
function extractCodexKeyConfig(toml: string): string {
    const KEY_FIELDS = [
        'model_provider', 'model', 'model_reasoning_effort',
        'review_model', 'plan_mode_reasoning_effort', 'disable_response_storage'
    ]
    const lines = toml.split('\n')
    const extracted: string[] = []
    let inModelProviders = false

    for (const line of lines) {
        const trimmed = line.trim()

        if (/^\[model_providers[.\]]/.test(trimmed)) {
            inModelProviders = true
            extracted.push(line)
            continue
        }

        if (inModelProviders && /^\[/.test(trimmed) && !/^\[model_providers[.\]]/.test(trimmed)) {
            inModelProviders = false
        }

        if (inModelProviders) {
            extracted.push(line)
            continue
        }

        const isKeyField = KEY_FIELDS.some(f => trimmed.startsWith(`${f} `) || trimmed.startsWith(`${f}=`))
        if (isKeyField) {
            extracted.push(line)
        }
    }

    return extracted.join('\n').trim()
}

/** Compose DB config from raw file contents */
function composeConfig(agentType: AgentType, file1: string, file2: string): Record<string, unknown> {
    const config: Record<string, unknown> = {}

    if (agentType === 'claude') {
        if (file1.trim()) {
            config.credentials = JSON.parse(file1)
        }
        if (file2.trim()) {
            const settings = JSON.parse(file2)
            if (settings.env && typeof settings.env === 'object') {
                config.settings = { env: settings.env }
            }
        }
    } else if (agentType === 'codex') {
        if (file1.trim()) {
            config.auth = JSON.parse(file1)
        }
        if (file2.trim()) {
            config.config = extractCodexKeyConfig(file2)
        }
    }

    return config
}

/** Decompose DB config into raw file contents for editing */
function decomposeConfig(agentType: AgentType, config: unknown): [string, string] {
    if (!config || typeof config !== 'object') return ['', '']

    const obj = config as Record<string, unknown>

    if (agentType === 'claude') {
        const file1 = obj.credentials ? JSON.stringify(obj.credentials, null, 2) : ''
        const settings = obj.settings as Record<string, unknown> | undefined
        const file2 = settings?.env ? JSON.stringify({ env: settings.env }, null, 2) : ''
        return [file1, file2]
    }

    if (agentType === 'codex') {
        const file1 = obj.auth ? JSON.stringify(obj.auth, null, 2) : ''
        const file2 = typeof obj.config === 'string' ? obj.config : ''
        return [file1, file2]
    }

    return ['', '']
}

const FILE_LABELS: Record<AgentType, [string, string]> = {
    claude: ['~/.claude/.credentials.json', '~/.claude/settings.json'],
    codex: ['~/.codex/auth.json', '~/.codex/config.toml'],
}

type FormMode = 'hidden' | 'create' | 'edit'

export default function CredentialsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { credentials, isLoading } = useCredentials(api, true)
    const { machines } = useMachines(api, true)
    const createMutation = useCreateCredential(api)
    const updateMutation = useUpdateCredential(api)
    const deleteMutation = useDeleteCredential(api)
    const applyMutation = useApplyCredentials(api)
    const readMutation = useReadMachineCredentials(api)

    const [formMode, setFormMode] = useState<FormMode>('hidden')
    const [editingId, setEditingId] = useState<string | null>(null)
    const [formName, setFormName] = useState('')
    const [formAgentType, setFormAgentType] = useState<AgentType>('claude')
    const [formFile1, setFormFile1] = useState('')
    const [formFile2, setFormFile2] = useState('')
    const [formError, setFormError] = useState<string | null>(null)

    const [importMachineId, setImportMachineId] = useState<string | null>(null)

    const [inlineApplyCredId, setInlineApplyCredId] = useState<string | null>(null)
    const [inlineApplyMachineId, setInlineApplyMachineId] = useState<string | null>(null)
    const [inlineApplyStatus, setInlineApplyStatus] = useState<string | null>(null)

    const claudeCredentials = credentials.filter(c => c.agentType === 'claude')
    const codexCredentials = credentials.filter(c => c.agentType === 'codex')
    const onlineMachines = machines.filter(m => m.active)

    const openCreate = () => {
        setFormMode('create')
        setEditingId(null)
        setFormName('')
        setFormAgentType('claude')
        setFormFile1('')
        setFormFile2('')
        setFormError(null)
    }

    const openEdit = (credential: Credential) => {
        setFormMode('edit')
        setEditingId(credential.id)
        setFormName(credential.name)
        setFormAgentType(credential.agentType)
        const [f1, f2] = decomposeConfig(credential.agentType, credential.config)
        setFormFile1(f1)
        setFormFile2(f2)
        setFormError(null)
    }

    const closeForm = () => {
        setFormMode('hidden')
        setEditingId(null)
        setFormError(null)
    }

    const handleImportFromMachine = async () => {
        if (!importMachineId) return
        setFormError(null)
        try {
            const result = await readMutation.mutateAsync({
                machineId: importMachineId,
                agentType: formAgentType
            })
            if (result.success && result.config) {
                const [f1, f2] = decomposeConfig(formAgentType, result.config)
                setFormFile1(f1)
                setFormFile2(f2)
            } else {
                setFormError(result.error ?? 'No credentials found on machine')
            }
        } catch (error) {
            setFormError(error instanceof Error ? error.message : 'Failed to read from machine')
        }
    }

    const handleSubmit = async () => {
        setFormError(null)

        if (!formName.trim()) {
            setFormError('Name is required')
            return
        }

        if (!formFile1.trim() && !formFile2.trim()) {
            setFormError('At least one file content is required')
            return
        }

        let config: Record<string, unknown>
        try {
            config = composeConfig(formAgentType, formFile1, formFile2)
        } catch (e) {
            setFormError(e instanceof Error ? e.message : 'Invalid file content')
            return
        }

        if (Object.keys(config).length === 0) {
            setFormError('No valid config extracted')
            return
        }

        try {
            if (formMode === 'create') {
                await createMutation.mutateAsync({
                    name: formName.trim(),
                    agentType: formAgentType,
                    config
                })
            } else if (formMode === 'edit' && editingId) {
                await updateMutation.mutateAsync({
                    id: editingId,
                    name: formName.trim(),
                    config
                })
            }
            closeForm()
        } catch (error) {
            setFormError(error instanceof Error ? error.message : 'Failed to save')
        }
    }

    const handleDelete = async (id: string) => {
        try {
            await deleteMutation.mutateAsync(id)
        } catch {
            // ignore
        }
    }

    const handleInlineApply = async (credentialId: string, agentType: AgentType) => {
        if (!inlineApplyMachineId) return
        setInlineApplyStatus(null)

        try {
            const result = await applyMutation.mutateAsync({
                machineId: inlineApplyMachineId,
                credentialId,
                agentType
            })
            if (result.success) {
                const writtenMsg = result.written?.length ? `: ${result.written.join(', ')}` : ''
                setInlineApplyStatus(`Applied successfully${writtenMsg}`)
            } else {
                setInlineApplyStatus(`Failed: ${result.error ?? 'Unknown error'}`)
            }
        } catch (error) {
            setInlineApplyStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
    }

    const [file1Label, file2Label] = FILE_LABELS[formAgentType]
    const isFile2Toml = formAgentType === 'codex'

    const renderCredentialList = (items: Credential[], label: string) => {
        if (items.length === 0) {
            return (
                <div className="px-3 py-4 text-sm text-[var(--app-hint)]">
                    No {label} credentials configured
                </div>
            )
        }

        return items.map(cred => (
            <div key={cred.id}>
                <div className="flex items-center justify-between px-3 py-3 transition-colors hover:bg-[var(--app-subtle-bg)]">
                    <div className="flex-1 min-w-0">
                        <div className="text-[var(--app-fg)] font-medium truncate">{cred.name}</div>
                        <div className="text-xs text-[var(--app-hint)] truncate mt-0.5">
                            {getCredentialPreview(cred.config, cred.agentType)}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 ml-2 shrink-0">
                        {onlineMachines.length > 0 && (
                            <button
                                type="button"
                                onClick={() => {
                                    setInlineApplyCredId(inlineApplyCredId === cred.id ? null : cred.id)
                                    setInlineApplyMachineId(null)
                                    setInlineApplyStatus(null)
                                }}
                                className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]"
                                title="Apply to machine"
                            >
                                <UploadIcon />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => openEdit(cred)}
                            className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                            title="Edit"
                        >
                            <EditIcon />
                        </button>
                        <button
                            type="button"
                            onClick={() => handleDelete(cred.id)}
                            className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-red-500 hover:bg-[var(--app-secondary-bg)]"
                            title="Delete"
                        >
                            <TrashIcon />
                        </button>
                    </div>
                </div>
                {inlineApplyCredId === cred.id && (
                    <div className="px-3 pb-3 flex items-center gap-2">
                        <select
                            value={inlineApplyMachineId ?? ''}
                            onChange={(e) => {
                                setInlineApplyMachineId(e.target.value || null)
                                setInlineApplyStatus(null)
                            }}
                            className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] focus:outline-none focus:border-[var(--app-link)]"
                        >
                            <option value="">Select machine...</option>
                            {onlineMachines.map(m => (
                                <option key={m.id} value={m.id}>
                                    {m.metadata?.displayName ?? m.metadata?.host ?? m.id}
                                </option>
                            ))}
                        </select>
                        <button
                            type="button"
                            onClick={() => handleInlineApply(cred.id, cred.agentType)}
                            disabled={!inlineApplyMachineId || applyMutation.isPending}
                            className="shrink-0 rounded-lg bg-[var(--app-link)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                        >
                            {applyMutation.isPending ? 'Applying...' : 'Apply'}
                        </button>
                    </div>
                )}
                {inlineApplyCredId === cred.id && inlineApplyStatus && (
                    <div className={`px-3 pb-3 text-xs ${inlineApplyStatus.startsWith('Applied') ? 'text-green-500' : 'text-red-500'}`}>
                        {inlineApplyStatus}
                    </div>
                )}
            </div>
        ))
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
                    <div className="flex-1 font-semibold">Credentials</div>
                    <button
                        type="button"
                        onClick={openCreate}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title="Add credential"
                    >
                        <PlusIcon />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {isLoading && (
                        <div className="px-3 py-8 text-center text-[var(--app-hint)]">Loading...</div>
                    )}

                    {/* Create/Edit Form */}
                    {formMode !== 'hidden' && (
                        <div className="border-b border-[var(--app-divider)] px-3 py-3">
                            <div className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">
                                {formMode === 'create' ? 'New Credential' : 'Edit Credential'}
                            </div>
                            <div className="space-y-2">
                                <input
                                    type="text"
                                    placeholder="Display name"
                                    value={formName}
                                    onChange={(e) => setFormName(e.target.value)}
                                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]"
                                />
                                <select
                                    value={formAgentType}
                                    onChange={(e) => {
                                        setFormAgentType(e.target.value as AgentType)
                                        setFormFile1('')
                                        setFormFile2('')
                                    }}
                                    disabled={formMode === 'edit'}
                                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] focus:outline-none focus:border-[var(--app-link)]"
                                >
                                    <option value="claude">Claude</option>
                                    <option value="codex">Codex</option>
                                </select>

                                {/* File 1 */}
                                <div>
                                    <div className="text-xs text-[var(--app-hint)] mb-1">{file1Label}</div>
                                    <textarea
                                        placeholder="Paste file contents here (optional)"
                                        value={formFile1}
                                        onChange={(e) => setFormFile1(e.target.value)}
                                        rows={5}
                                        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-mono text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)] resize-y"
                                    />
                                </div>

                                {/* File 2 */}
                                <div>
                                    <div className="text-xs text-[var(--app-hint)] mb-1">
                                        {file2Label}
                                        {!isFile2Toml && <span className="ml-1 opacity-60">(env vars will be extracted)</span>}
                                        {isFile2Toml && <span className="ml-1 opacity-60">(key fields will be extracted)</span>}
                                    </div>
                                    <textarea
                                        placeholder="Paste file contents here (optional)"
                                        value={formFile2}
                                        onChange={(e) => setFormFile2(e.target.value)}
                                        rows={5}
                                        className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-mono text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)] resize-y"
                                    />
                                </div>

                                {onlineMachines.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={importMachineId ?? ''}
                                            onChange={(e) => setImportMachineId(e.target.value || null)}
                                            className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-sm text-[var(--app-fg)] focus:outline-none focus:border-[var(--app-link)]"
                                        >
                                            <option value="">Select machine...</option>
                                            {onlineMachines.map(m => (
                                                <option key={m.id} value={m.id}>
                                                    {m.metadata?.displayName ?? m.metadata?.host ?? m.id}
                                                </option>
                                            ))}
                                        </select>
                                        <button
                                            type="button"
                                            onClick={handleImportFromMachine}
                                            disabled={!importMachineId || readMutation.isPending}
                                            className="shrink-0 rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                                        >
                                            {readMutation.isPending ? 'Reading...' : 'Import from Machine'}
                                        </button>
                                    </div>
                                )}
                                {formError && (
                                    <div className="text-xs text-red-500">{formError}</div>
                                )}
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={handleSubmit}
                                        disabled={createMutation.isPending || updateMutation.isPending}
                                        className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                                    >
                                        {createMutation.isPending || updateMutation.isPending ? 'Saving...' : 'Save'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={closeForm}
                                        className="rounded-lg border border-[var(--app-border)] px-4 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Claude Credentials */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Claude Credentials
                        </div>
                        {renderCredentialList(claudeCredentials, 'Claude')}
                    </div>

                    {/* Codex Credentials */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Codex Credentials
                        </div>
                        {renderCredentialList(codexCredentials, 'Codex')}
                    </div>

                </div>
            </div>
        </div>
    )
}
