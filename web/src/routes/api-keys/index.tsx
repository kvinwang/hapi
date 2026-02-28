import { useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useApiKeys, useAccessTokens } from '@/hooks/queries/useApiKeys'
import {
    useCreateApiKey,
    useUpdateApiKeyPermissions,
    useRevokeApiKey,
    useRevokeAccessToken
} from '@/hooks/mutations/useApiKeyActions'
import type { ApiKey, ApiKeyPermission, AccessToken } from '@/types/api'

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

function CopyIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

function ChevronIcon(props: { expanded: boolean }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${props.expanded ? 'rotate-90' : ''}`}>
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function EditIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

const ALL_PERMISSIONS: { value: ApiKeyPermission; label: string; description: string }[] = [
    { value: 'api_keys:manage', label: 'Manage API Keys', description: 'Create, list, and revoke API keys and tokens' },
    { value: 'sessions:read', label: 'Read Sessions', description: 'View sessions, messages, and history' },
    { value: 'sessions:read:all', label: 'Read All Sessions', description: 'View sessions across all namespaces' },
    { value: 'sessions:write', label: 'Write Sessions', description: 'Create and load sessions' },
    { value: 'machines:read', label: 'Read Machines', description: 'List and view machines' },
    { value: 'machines:read:all', label: 'Read All Machines', description: 'View machines across all namespaces' },
    { value: 'machines:write', label: 'Write Machines', description: 'Register and update machines' },
    { value: 'machines:manage', label: 'Manage Machines', description: 'Reassign machine API key bindings' },
    { value: 'machines:ssh:manage', label: 'Manage SSH Keys', description: 'Import SSH public keys to remote machines' },
]

function formatTime(ts: number): string {
    const d = new Date(ts)
    const now = Date.now()
    const diff = now - ts

    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
}

function formatDuration(ms: number): string {
    const days = Math.round(ms / (24 * 60 * 60 * 1000))
    if (days >= 365) return `${Math.round(days / 365)}y`
    if (days >= 30) return `${Math.round(days / 30)}mo`
    return `${days}d`
}

function PermissionBadge(props: { permission: ApiKeyPermission }) {
    const colors: Record<string, string> = {
        'admin': 'bg-red-500/15 text-red-400',
        'api_keys:manage': 'bg-blue-500/15 text-blue-400',
        'sessions:read': 'bg-teal-500/15 text-teal-400',
        'sessions:read:all': 'bg-green-500/15 text-green-400',
        'sessions:write': 'bg-emerald-500/15 text-emerald-400',
        'machines:read': 'bg-indigo-500/15 text-indigo-400',
        'machines:read:all': 'bg-purple-500/15 text-purple-400',
        'machines:write': 'bg-violet-500/15 text-violet-400',
        'machines:manage': 'bg-fuchsia-500/15 text-fuchsia-400',
        'machines:ssh:manage': 'bg-amber-500/15 text-amber-400',
    }
    return (
        <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${colors[props.permission] ?? 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}>
            {props.permission}
        </span>
    )
}

const PERMISSION_PRESETS: { label: string; permissions: ApiKeyPermission[] }[] = [
    { label: 'None', permissions: [] },
    { label: 'Read Only', permissions: ['sessions:read', 'machines:read'] },
    { label: 'Vibe Coder', permissions: ['sessions:read', 'sessions:write', 'machines:read'] },
    { label: 'Runner', permissions: ['sessions:write', 'machines:write'] },
    { label: 'Admin', permissions: ['admin'] },
]

function PermissionPresetButtons(props: { selected: ApiKeyPermission[]; onSelect: (permissions: ApiKeyPermission[]) => void }) {
    const isMatch = (preset: ApiKeyPermission[]) => {
        if (preset.length !== props.selected.length) return false
        return preset.every(p => props.selected.includes(p))
    }

    return (
        <div className="flex flex-wrap gap-1.5 mb-2">
            {PERMISSION_PRESETS.map(preset => {
                const active = isMatch(preset.permissions)
                const isAdmin = preset.permissions.includes('admin')
                return (
                    <button
                        key={preset.label}
                        type="button"
                        onClick={() => props.onSelect([...preset.permissions])}
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border transition-colors ${
                            active
                                ? isAdmin
                                    ? 'border-red-400/50 bg-red-500/15 text-red-400'
                                    : 'border-[var(--app-link)] bg-[var(--app-link)]/10 text-[var(--app-link)]'
                                : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:border-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]'
                        }`}
                    >
                        {preset.label}
                    </button>
                )
            })}
        </div>
    )
}

function PermissionEditor(props: {
    permissions: ApiKeyPermission[]
    onSave: (permissions: ApiKeyPermission[]) => void
    onCancel: () => void
    saving: boolean
}) {
    const [selected, setSelected] = useState<ApiKeyPermission[]>(props.permissions)

    const toggle = (p: ApiKeyPermission) => {
        setSelected(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
    }

    const isAdmin = selected.includes('admin')

    return (
        <div className="px-3 py-2 bg-[var(--app-subtle-bg)] rounded-lg mt-1 mb-2">
            <div className="text-xs text-[var(--app-hint)] mb-1.5">Edit Permissions</div>
            <PermissionPresetButtons selected={selected} onSelect={setSelected} />
            {isAdmin ? (
                <div className="rounded px-3 py-2 bg-red-500/10 border border-red-400/20 text-xs text-red-400">
                    Full access — all permission checks bypassed
                </div>
            ) : (
                <div className="space-y-1">
                    {ALL_PERMISSIONS.map(p => (
                        <label key={p.value} className="flex items-start gap-2 px-1 py-0.5 rounded hover:bg-[var(--app-secondary-bg)] cursor-pointer">
                            <input
                                type="checkbox"
                                checked={selected.includes(p.value)}
                                onChange={() => toggle(p.value)}
                                className="mt-0.5 accent-[var(--app-link)]"
                            />
                            <div>
                                <div className="text-xs text-[var(--app-fg)]">{p.label}</div>
                                <div className="text-[10px] text-[var(--app-hint)]">{p.description}</div>
                            </div>
                        </label>
                    ))}
                </div>
            )}
            <div className="flex gap-2 mt-2">
                <button
                    type="button"
                    onClick={() => props.onSave(selected)}
                    disabled={props.saving}
                    className="rounded px-3 py-1 text-xs font-medium bg-[var(--app-link)] text-white hover:opacity-90 disabled:opacity-50"
                >
                    {props.saving ? 'Saving...' : 'Save'}
                </button>
                <button
                    type="button"
                    onClick={props.onCancel}
                    className="rounded px-3 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                >
                    Cancel
                </button>
            </div>
        </div>
    )
}

function TokenRow(props: { token: AccessToken; apiKeyId: string; onRevoke: (input: { apiKeyId: string; tokenId: string }) => void; revoking: boolean }) {
    const { token, apiKeyId, onRevoke, revoking } = props
    const neverExpires = token.expiresAt === 0
    const isExpired = !neverExpires && token.expiresAt < Date.now()
    const isRevoked = token.revokedAt !== null

    return (
        <div className={`flex items-center justify-between px-3 py-2 text-xs ${isRevoked || isExpired ? 'opacity-50' : ''}`}>
            <div className="flex-1 min-w-0">
                <div className="font-medium text-[var(--app-fg)] truncate">{token.name}</div>
                <div className="flex items-center gap-1 mt-0.5">
                    <span className="font-mono text-[var(--app-hint)]">{token.tokenPrefix}...</span>
                    <span className="text-[var(--app-hint)]">·</span>
                    <span className="text-[var(--app-hint)]">
                        {isRevoked ? 'Revoked' : isExpired ? 'Expired' : neverExpires ? 'Never expires' : `Expires ${formatTime(token.expiresAt)}`}
                    </span>
                    {!isRevoked && !isExpired && !neverExpires && (
                        <>
                            <span className="text-[var(--app-hint)]">·</span>
                            <span className="text-[var(--app-hint)]">{formatDuration(token.expiresAt - token.createdAt)}</span>
                        </>
                    )}
                </div>
            </div>
            {!isRevoked && !isExpired && (
                <button
                    type="button"
                    onClick={() => onRevoke({ apiKeyId, tokenId: token.id })}
                    disabled={revoking}
                    className="shrink-0 ml-2 rounded px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                >
                    Revoke
                </button>
            )}
        </div>
    )
}

function AccessTokensList(props: { apiKeyId: string }) {
    const { api } = useAppContext()
    const { tokens, isLoading } = useAccessTokens(api, props.apiKeyId)
    const revokeMutation = useRevokeAccessToken(api)

    if (isLoading) {
        return <div className="px-3 py-2 text-xs text-[var(--app-hint)]">Loading tokens...</div>
    }

    if (tokens.length === 0) {
        return <div className="px-3 py-2 text-xs text-[var(--app-hint)]">No access tokens</div>
    }

    return (
        <div className="border-t border-[var(--app-divider)]">
            {tokens.map(token => (
                <TokenRow
                    key={token.id}
                    token={token}
                    apiKeyId={props.apiKeyId}
                    onRevoke={(input) => revokeMutation.mutate(input)}
                    revoking={revokeMutation.isPending}
                />
            ))}
        </div>
    )
}

export default function ApiKeysPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { apiKeys, isLoading } = useApiKeys(api, true)
    const createMutation = useCreateApiKey(api)
    const revokeMutation = useRevokeApiKey(api)
    const updatePermsMutation = useUpdateApiKeyPermissions(api)

    const [showForm, setShowForm] = useState(false)
    const [formName, setFormName] = useState('')
    const [formPermissions, setFormPermissions] = useState<ApiKeyPermission[]>([])
    const [formError, setFormError] = useState<string | null>(null)

    const [createdKey, setCreatedKey] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null)
    const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
    const [editingPermsKeyId, setEditingPermsKeyId] = useState<string | null>(null)

    const activeKeys = apiKeys.filter(k => k.revokedAt === null)
    const revokedKeys = apiKeys.filter(k => k.revokedAt !== null)

    const openCreate = () => {
        setShowForm(true)
        setFormName('')
        setFormPermissions([])
        setFormError(null)
        setCreatedKey(null)
    }

    const closeForm = () => {
        setShowForm(false)
        setFormError(null)
        setCreatedKey(null)
    }

    const togglePermission = (p: ApiKeyPermission) => {
        setFormPermissions(prev =>
            prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
        )
    }

    const handleCreate = async () => {
        setFormError(null)
        if (!formName.trim()) {
            setFormError('Name is required')
            return
        }
        try {
            const result = await createMutation.mutateAsync({
                name: formName.trim(),
                permissions: formPermissions
            })
            setCreatedKey(result.rawKey)
            setFormName('')
            setFormPermissions([])
        } catch (error) {
            setFormError(error instanceof Error ? error.message : 'Failed to create API key')
        }
    }

    const handleCopy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            // fallback: select text
        }
    }

    const handleRevoke = async (id: string) => {
        try {
            await revokeMutation.mutateAsync(id)
            setConfirmRevokeId(null)
        } catch {
            // ignore
        }
    }

    const handleSavePermissions = async (keyId: string, permissions: ApiKeyPermission[]) => {
        try {
            await updatePermsMutation.mutateAsync({ id: keyId, permissions })
            setEditingPermsKeyId(null)
        } catch {
            // ignore
        }
    }

    const renderKeyRow = (key: ApiKey) => {
        const isRevoked = key.revokedAt !== null
        const isExpanded = expandedKeyId === key.id
        const isEditingPerms = editingPermsKeyId === key.id

        return (
            <div key={key.id} className={isRevoked ? 'opacity-50' : ''}>
                <div className="flex items-center gap-2 px-3 py-3 transition-colors hover:bg-[var(--app-subtle-bg)]">
                    {!isRevoked && (
                        <button
                            type="button"
                            onClick={() => setExpandedKeyId(isExpanded ? null : key.id)}
                            className="shrink-0 text-[var(--app-hint)]"
                        >
                            <ChevronIcon expanded={isExpanded} />
                        </button>
                    )}
                    <div className="flex-1 min-w-0">
                        <div className={`font-medium truncate ${isRevoked ? 'line-through text-[var(--app-hint)]' : 'text-[var(--app-fg)]'}`}>
                            {key.name}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 mt-0.5">
                            <span className="text-xs font-mono text-[var(--app-hint)]">{key.keyPrefix}...</span>
                            <span className="text-xs text-[var(--app-hint)]">· {key.namespace}</span>
                            {key.lastUsedAt && (
                                <span className="text-xs text-[var(--app-hint)]">· used {formatTime(key.lastUsedAt)}</span>
                            )}
                        </div>
                        {key.permissions.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                                {key.permissions.map(p => (
                                    <PermissionBadge key={p} permission={p} />
                                ))}
                            </div>
                        )}
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                        {isRevoked ? (
                            <span className="text-xs text-red-400">Revoked</span>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setEditingPermsKeyId(isEditingPerms ? null : key.id)}
                                    className="rounded p-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                                    title="Edit permissions"
                                >
                                    <EditIcon />
                                </button>
                                {confirmRevokeId === key.id ? (
                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => handleRevoke(key.id)}
                                            disabled={revokeMutation.isPending}
                                            className="rounded px-2 py-1 text-xs font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                                        >
                                            Confirm
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setConfirmRevokeId(null)}
                                            className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setConfirmRevokeId(key.id)}
                                        className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:text-red-400 hover:bg-red-500/10"
                                    >
                                        Revoke
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>
                {isEditingPerms && !isRevoked && (
                    <div className="mx-3">
                        <PermissionEditor
                            permissions={key.permissions}
                            onSave={(perms) => handleSavePermissions(key.id, perms)}
                            onCancel={() => setEditingPermsKeyId(null)}
                            saving={updatePermsMutation.isPending}
                        />
                    </div>
                )}
                {isExpanded && !isRevoked && (
                    <div className="ml-6 mb-2 bg-[var(--app-subtle-bg)] rounded-lg overflow-hidden">
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Access Tokens
                        </div>
                        <AccessTokensList apiKeyId={key.id} />
                    </div>
                )}
            </div>
        )
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
                    <div className="flex-1 font-semibold">API Keys</div>
                    <button
                        type="button"
                        onClick={openCreate}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title="Create API key"
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

                    {/* Create Form */}
                    {showForm && !createdKey && (
                        <div className="border-b border-[var(--app-divider)] px-3 py-3">
                            <div className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">
                                New API Key
                            </div>
                            <div className="space-y-2">
                                <input
                                    type="text"
                                    placeholder="Key name (e.g. CI/CD, Mobile App)"
                                    value={formName}
                                    onChange={(e) => setFormName(e.target.value)}
                                    className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]"
                                />
                                <div>
                                    <div className="text-xs text-[var(--app-hint)] mb-1.5">Permissions</div>
                                    <PermissionPresetButtons selected={formPermissions} onSelect={setFormPermissions} />
                                    {formPermissions.includes('admin') ? (
                                        <div className="rounded-lg px-3 py-2 bg-red-500/10 border border-red-400/20 text-xs text-red-400">
                                            Full access — all permission checks bypassed
                                        </div>
                                    ) : (
                                        <div className="space-y-1">
                                            {ALL_PERMISSIONS.map(p => (
                                                <label key={p.value} className="flex items-start gap-2 px-1 py-1 rounded hover:bg-[var(--app-subtle-bg)] cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={formPermissions.includes(p.value)}
                                                        onChange={() => togglePermission(p.value)}
                                                        className="mt-0.5 accent-[var(--app-link)]"
                                                    />
                                                    <div>
                                                        <div className="text-sm text-[var(--app-fg)]">{p.label}</div>
                                                        <div className="text-xs text-[var(--app-hint)]">{p.description}</div>
                                                    </div>
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                {formError && (
                                    <div className="text-xs text-red-500">{formError}</div>
                                )}
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={handleCreate}
                                        disabled={createMutation.isPending}
                                        className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                                    >
                                        {createMutation.isPending ? 'Creating...' : 'Create'}
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

                    {/* Created Key Display */}
                    {createdKey && (
                        <div className="border-b border-[var(--app-divider)] px-3 py-3">
                            <div className="text-xs font-semibold text-green-400 uppercase tracking-wide mb-2">
                                API Key Created
                            </div>
                            <div className="text-xs text-[var(--app-hint)] mb-2">
                                Copy this key now. It will not be shown again.
                            </div>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 rounded-lg bg-[var(--app-subtle-bg)] border border-[var(--app-border)] px-3 py-2 text-xs font-mono text-[var(--app-fg)] break-all select-all">
                                    {createdKey}
                                </code>
                                <button
                                    type="button"
                                    onClick={() => handleCopy(createdKey)}
                                    className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                                    title="Copy to clipboard"
                                >
                                    {copied ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400"><polyline points="20 6 9 17 4 12" /></svg>
                                    ) : (
                                        <CopyIcon />
                                    )}
                                </button>
                            </div>
                            <button
                                type="button"
                                onClick={closeForm}
                                className="mt-2 rounded-lg border border-[var(--app-border)] px-4 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
                            >
                                Done
                            </button>
                        </div>
                    )}

                    {/* Active Keys */}
                    {!isLoading && (
                        <div className="border-b border-[var(--app-divider)]">
                            <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                                Active Keys ({activeKeys.length})
                            </div>
                            {activeKeys.length === 0 ? (
                                <div className="px-3 py-4 text-sm text-[var(--app-hint)]">
                                    No active API keys
                                </div>
                            ) : (
                                activeKeys.map(renderKeyRow)
                            )}
                        </div>
                    )}

                    {/* Revoked Keys */}
                    {revokedKeys.length > 0 && (
                        <div className="border-b border-[var(--app-divider)]">
                            <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                                Revoked Keys ({revokedKeys.length})
                            </div>
                            {revokedKeys.map(renderKeyRow)}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
