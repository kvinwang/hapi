import { useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useApiKeys, useAccessTokens } from '@/hooks/queries/useApiKeys'
import {
    useCreateApiKey,
    useUpdateApiKey,
    useCreateAccessToken,
    useUpdateAccessToken,
    useRevokeApiKey,
    useRestoreApiKey,
    useRevokeAccessToken,
    useRestoreAccessToken
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

function EditIcon({ size = 14 }: { size?: number }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

function CheckIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400"><polyline points="20 6 9 17 4 12" /></svg>
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
    { value: 'machines:connect', label: 'Connect Machines', description: 'Create tunnel connections to machines' },
    { value: 'machines:shell', label: 'Shell Access', description: 'Access built-in SSH shell (port 0)' },
    { value: 'machines:manage', label: 'Manage Machines', description: 'Delete machines and manage bindings' },
    { value: 'machines:ssh:manage', label: 'Manage SSH Keys', description: 'Import SSH public keys to remote machines' },
]

function formatTime(ts: number): string {
    const d = new Date(ts)
    const now = Date.now()
    const diff = now - ts

    if (diff < 0) {
        const remaining = -diff
        if (remaining < 60_000) return 'in <1m'
        if (remaining < 3600_000) return `in ${Math.floor(remaining / 60_000)}m`
        if (remaining < 86400_000) return `in ${Math.floor(remaining / 3600_000)}h`
        return `in ${Math.floor(remaining / 86400_000)}d`
    }

    if (diff < 60_000) return 'just now'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined })
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
        'machines:connect': 'bg-cyan-500/15 text-cyan-400',
        'machines:shell': 'bg-orange-500/15 text-orange-400',
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

function PermissionsCheckboxes(props: { selected: ApiKeyPermission[]; onToggle: (p: ApiKeyPermission) => void }) {
    return props.selected.includes('admin') ? (
        <div className="rounded px-3 py-2 bg-red-500/10 border border-red-400/20 text-xs text-red-400">
            Full access — all permission checks bypassed
        </div>
    ) : (
        <div className="space-y-1">
            {ALL_PERMISSIONS.map(p => (
                <label key={p.value} className="flex items-start gap-2 px-1 py-0.5 rounded hover:bg-[var(--app-secondary-bg)] cursor-pointer">
                    <input
                        type="checkbox"
                        checked={props.selected.includes(p.value)}
                        onChange={() => props.onToggle(p.value)}
                        className="mt-0.5 accent-[var(--app-link)]"
                    />
                    <div>
                        <div className="text-xs text-[var(--app-fg)]">{p.label}</div>
                        <div className="text-[10px] text-[var(--app-hint)]">{p.description}</div>
                    </div>
                </label>
            ))}
        </div>
    )
}

// --- Shared expiry options ---
type ExpiresIn = '1d' | '7d' | '30d' | 'never'
const EXPIRY_OPTIONS: { value: ExpiresIn; label: string }[] = [
    { value: '1d', label: '1 Day' },
    { value: '7d', label: '1 Week' },
    { value: '30d', label: '1 Month' },
    { value: 'never', label: 'Never' },
]

function ExpirySelector(props: { value: ExpiresIn; onChange: (v: ExpiresIn) => void }) {
    return (
        <div className="flex gap-1">
            {EXPIRY_OPTIONS.map(opt => (
                <button
                    key={opt.value}
                    type="button"
                    onClick={() => props.onChange(opt.value)}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium border transition-colors ${
                        props.value === opt.value
                            ? opt.value === 'never'
                                ? 'border-orange-400/50 bg-orange-500/15 text-orange-400'
                                : 'border-[var(--app-link)] bg-[var(--app-link)]/10 text-[var(--app-link)]'
                            : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:border-[var(--app-link)]'
                    }`}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    )
}

// --- Shared "copy raw key/token" display ---
function CreatedSecretDisplay(props: { label: string; secret: string; onDone: () => void }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(props.secret)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch { /* fallback */ }
    }

    return (
        <div className="px-3 py-2 border-b border-[var(--app-divider)]">
            <div className="text-[10px] font-semibold text-green-400 uppercase tracking-wide mb-1">{props.label}</div>
            <div className="text-[10px] text-[var(--app-hint)] mb-1.5">Copy now. It will not be shown again.</div>
            <div className="flex items-center gap-1.5">
                <code className="flex-1 rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)] px-2 py-1 text-[10px] font-mono text-[var(--app-fg)] break-all select-all">
                    {props.secret}
                </code>
                <button type="button" onClick={handleCopy} className="shrink-0 p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]" title="Copy">
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            </div>
            <button type="button" onClick={props.onDone} className="mt-1.5 rounded px-2.5 py-1 text-[10px] text-[var(--app-hint)] border border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]">
                Done
            </button>
        </div>
    )
}

// --- Confirm/Cancel inline ---
function ConfirmAction(props: { onConfirm: () => void; onCancel: () => void; label: string; pending: boolean }) {
    return (
        <div className="flex items-center gap-1">
            <button
                type="button"
                onClick={props.onConfirm}
                disabled={props.pending}
                className="rounded px-2 py-1 text-[10px] font-medium bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-50"
            >
                {props.pending ? '...' : props.label}
            </button>
            <button
                type="button"
                onClick={props.onCancel}
                className="rounded px-2 py-1 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
            >
                Cancel
            </button>
        </div>
    )
}

// ========== Token Row ==========
function TokenRow(props: {
    token: AccessToken
    apiKeyId: string
    onEdit: (token: AccessToken) => void
    onRevoke: (input: { apiKeyId: string; tokenId: string }) => void
    onRestore: (input: { apiKeyId: string; tokenId: string }) => void
    revoking: boolean
    restoring: boolean
}) {
    const { token, apiKeyId, onEdit, onRevoke, onRestore, revoking, restoring } = props
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
                </div>
            </div>
            <div className="shrink-0 ml-2 flex items-center gap-1">
                {isRevoked ? (
                    <button
                        type="button"
                        onClick={() => onRestore({ apiKeyId, tokenId: token.id })}
                        disabled={restoring}
                        className="rounded px-2 py-1 text-[10px] font-medium text-[var(--app-hint)] hover:text-green-400 hover:bg-green-500/10 disabled:opacity-50"
                    >
                        Restore
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => onEdit(token)}
                            className="rounded p-1 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                            title="Edit"
                        >
                            <EditIcon size={12} />
                        </button>
                        <button
                            type="button"
                            onClick={() => onRevoke({ apiKeyId, tokenId: token.id })}
                            disabled={revoking}
                            className="rounded px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                            Revoke
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}

// ========== Token Edit Form (reused for create & edit) ==========
function TokenForm(props: {
    initialName: string
    initialExpiresIn: ExpiresIn
    submitLabel: string
    onSubmit: (name: string, expiresIn: ExpiresIn) => void
    onCancel: () => void
    pending: boolean
}) {
    const [name, setName] = useState(props.initialName)
    const [expiresIn, setExpiresIn] = useState<ExpiresIn>(props.initialExpiresIn)

    return (
        <div className="px-3 py-2 border-b border-[var(--app-divider)]">
            <div className="space-y-2">
                <input
                    type="text"
                    placeholder="Token name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && name.trim() && props.onSubmit(name.trim(), expiresIn)}
                    className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]"
                />
                <div>
                    <div className="text-[10px] text-[var(--app-hint)] mb-1">Expiry</div>
                    <ExpirySelector value={expiresIn} onChange={setExpiresIn} />
                </div>
                <div className="flex gap-1.5">
                    <button
                        type="button"
                        onClick={() => name.trim() && props.onSubmit(name.trim(), expiresIn)}
                        disabled={props.pending || !name.trim()}
                        className="rounded px-2.5 py-1 text-[10px] font-medium bg-[var(--app-link)] text-white hover:opacity-90 disabled:opacity-50"
                    >
                        {props.pending ? '...' : props.submitLabel}
                    </button>
                    <button
                        type="button"
                        onClick={props.onCancel}
                        className="rounded px-2.5 py-1 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}

// ========== Access Tokens List ==========
function AccessTokensList(props: { apiKeyId: string }) {
    const { api } = useAppContext()
    const { tokens, isLoading } = useAccessTokens(api, props.apiKeyId)
    const createMutation = useCreateAccessToken(api)
    const updateMutation = useUpdateAccessToken(api)
    const revokeMutation = useRevokeAccessToken(api)
    const restoreMutation = useRestoreAccessToken(api)

    const [mode, setMode] = useState<'idle' | 'create' | 'edit'>('idle')
    const [editingToken, setEditingToken] = useState<AccessToken | null>(null)
    const [createdRawToken, setCreatedRawToken] = useState<string | null>(null)

    const handleCreate = async (name: string, expiresIn: ExpiresIn) => {
        try {
            const result = await createMutation.mutateAsync({ apiKeyId: props.apiKeyId, name, expiresIn })
            setCreatedRawToken(result.rawToken)
        } catch { /* handled by mutation */ }
    }

    const handleEdit = async (name: string, expiresIn: ExpiresIn) => {
        if (!editingToken) return
        try {
            await updateMutation.mutateAsync({
                apiKeyId: props.apiKeyId,
                tokenId: editingToken.id,
                name,
                expiresIn,
            })
            setMode('idle')
            setEditingToken(null)
        } catch { /* handled by mutation */ }
    }

    const closeForm = () => {
        setMode('idle')
        setEditingToken(null)
        setCreatedRawToken(null)
    }

    if (isLoading) {
        return <div className="px-3 py-2 text-xs text-[var(--app-hint)]">Loading tokens...</div>
    }

    return (
        <div className="border-t border-[var(--app-divider)]">
            {/* Create form */}
            {mode === 'create' && !createdRawToken && (
                <TokenForm
                    initialName=""
                    initialExpiresIn="7d"
                    submitLabel="Create"
                    onSubmit={handleCreate}
                    onCancel={closeForm}
                    pending={createMutation.isPending}
                />
            )}

            {/* Edit form */}
            {mode === 'edit' && editingToken && (
                <TokenForm
                    initialName={editingToken.name}
                    initialExpiresIn={editingToken.expiresAt === 0 ? 'never' : '7d'}
                    submitLabel="Save"
                    onSubmit={handleEdit}
                    onCancel={closeForm}
                    pending={updateMutation.isPending}
                />
            )}

            {/* Created token display */}
            {createdRawToken && (
                <CreatedSecretDisplay label="Token Created" secret={createdRawToken} onDone={closeForm} />
            )}

            {/* Token list */}
            {tokens.length === 0 && mode === 'idle' && (
                <div className="px-3 py-2 text-xs text-[var(--app-hint)]">No access tokens</div>
            )}
            {tokens.map(token => (
                <TokenRow
                    key={token.id}
                    token={token}
                    apiKeyId={props.apiKeyId}
                    onEdit={(t) => { setEditingToken(t); setMode('edit') }}
                    onRevoke={(input) => revokeMutation.mutate(input)}
                    onRestore={(input) => restoreMutation.mutate(input)}
                    revoking={revokeMutation.isPending}
                    restoring={restoreMutation.isPending}
                />
            ))}

            {/* New token button */}
            {mode === 'idle' && !createdRawToken && (
                <button
                    type="button"
                    onClick={() => setMode('create')}
                    className="w-full px-3 py-1.5 text-[10px] text-[var(--app-link)] hover:bg-[var(--app-link)]/5 text-left font-medium"
                >
                    + New Token
                </button>
            )}
        </div>
    )
}

// ========== API Key Edit Form (name + permissions) ==========
function ApiKeyEditForm(props: {
    initialName: string
    initialPermissions: ApiKeyPermission[]
    submitLabel: string
    onSubmit: (name: string, permissions: ApiKeyPermission[]) => void
    onCancel: () => void
    pending: boolean
}) {
    const [name, setName] = useState(props.initialName)
    const [permissions, setPermissions] = useState<ApiKeyPermission[]>(props.initialPermissions)

    const toggle = (p: ApiKeyPermission) => {
        setPermissions(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
    }

    return (
        <div className="px-3 py-2 bg-[var(--app-subtle-bg)] rounded-lg mt-1 mb-2">
            <div className="space-y-2">
                <div>
                    <div className="text-xs text-[var(--app-hint)] mb-1">Name</div>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Key name"
                        className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]"
                    />
                </div>
                <div>
                    <div className="text-xs text-[var(--app-hint)] mb-1.5">Permissions</div>
                    <PermissionPresetButtons selected={permissions} onSelect={setPermissions} />
                    <PermissionsCheckboxes selected={permissions} onToggle={toggle} />
                </div>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => name.trim() && props.onSubmit(name.trim(), permissions)}
                        disabled={props.pending || !name.trim()}
                        className="rounded px-3 py-1 text-xs font-medium bg-[var(--app-link)] text-white hover:opacity-90 disabled:opacity-50"
                    >
                        {props.pending ? '...' : props.submitLabel}
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
        </div>
    )
}

// ========== Main Page ==========
export default function ApiKeysPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { apiKeys, isLoading } = useApiKeys(api, true)
    const createMutation = useCreateApiKey(api)
    const updateMutation = useUpdateApiKey(api)
    const revokeMutation = useRevokeApiKey(api)
    const restoreMutation = useRestoreApiKey(api)

    const [showForm, setShowForm] = useState(false)
    const [createdKey, setCreatedKey] = useState<string | null>(null)

    const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null)
    const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)
    const [editingKeyId, setEditingKeyId] = useState<string | null>(null)

    const activeKeys = apiKeys.filter(k => k.revokedAt === null)
    const revokedKeys = apiKeys.filter(k => k.revokedAt !== null)

    const handleCreate = async (name: string, permissions: ApiKeyPermission[]) => {
        try {
            const result = await createMutation.mutateAsync({ name, permissions })
            setCreatedKey(result.rawKey)
        } catch { /* handled */ }
    }

    const handleUpdate = async (keyId: string, name: string, permissions: ApiKeyPermission[]) => {
        try {
            await updateMutation.mutateAsync({ id: keyId, name, permissions })
            setEditingKeyId(null)
        } catch { /* handled */ }
    }

    const handleRevoke = async (id: string) => {
        try {
            await revokeMutation.mutateAsync(id)
            setConfirmRevokeId(null)
        } catch { /* handled */ }
    }

    const handleRestore = async (id: string) => {
        try { await restoreMutation.mutateAsync(id) } catch { /* handled */ }
    }

    const closeForm = () => {
        setShowForm(false)
        setCreatedKey(null)
    }

    const renderKeyRow = (key: ApiKey) => {
        const isRevoked = key.revokedAt !== null
        const isExpanded = expandedKeyId === key.id
        const isEditing = editingKeyId === key.id

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
                            <button
                                type="button"
                                onClick={() => handleRestore(key.id)}
                                disabled={restoreMutation.isPending}
                                className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:text-green-400 hover:bg-green-500/10 disabled:opacity-50"
                            >
                                Restore
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setEditingKeyId(isEditing ? null : key.id)}
                                    className="rounded p-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                                    title="Edit"
                                >
                                    <EditIcon />
                                </button>
                                {confirmRevokeId === key.id ? (
                                    <ConfirmAction
                                        onConfirm={() => handleRevoke(key.id)}
                                        onCancel={() => setConfirmRevokeId(null)}
                                        label="Confirm"
                                        pending={revokeMutation.isPending}
                                    />
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
                {isEditing && !isRevoked && (
                    <div className="mx-3">
                        <ApiKeyEditForm
                            initialName={key.name}
                            initialPermissions={key.permissions}
                            submitLabel="Save"
                            onSubmit={(name, perms) => handleUpdate(key.id, name, perms)}
                            onCancel={() => setEditingKeyId(null)}
                            pending={updateMutation.isPending}
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
                        onClick={() => { setShowForm(true); setCreatedKey(null) }}
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
                            <ApiKeyEditForm
                                initialName=""
                                initialPermissions={[]}
                                submitLabel="Create"
                                onSubmit={handleCreate}
                                onCancel={closeForm}
                                pending={createMutation.isPending}
                            />
                        </div>
                    )}

                    {/* Created Key Display */}
                    {createdKey && (
                        <CreatedSecretDisplay label="API Key Created" secret={createdKey} onDone={closeForm} />
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
