import { useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation, type I18nContextValue } from '@/lib/use-translation'
import { SettingsScreen, headerIconButtonClass } from '@/routes/settings/header'
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

type Translate = I18nContextValue['t']

const ALL_PERMISSIONS: { value: ApiKeyPermission; key: string }[] = [
    { value: 'api_keys:manage', key: 'manageApiKeys' },
    { value: 'sessions:read', key: 'readSessions' },
    { value: 'sessions:read:all', key: 'readAllSessions' },
    { value: 'sessions:write', key: 'writeSessions' },
    { value: 'machines:read', key: 'readMachines' },
    { value: 'machines:read:all', key: 'readAllMachines' },
    { value: 'machines:write', key: 'writeMachines' },
    { value: 'machines:connect', key: 'connectMachines' },
    { value: 'machines:shell', key: 'shell' },
    { value: 'machines:manage', key: 'manageMachines' },
    { value: 'machines:ssh:manage', key: 'manageSsh' },
]

function formatTime(ts: number, t: Translate): string {
    const d = new Date(ts)
    const now = Date.now()
    const diff = now - ts

    if (diff < 0) {
        const remaining = -diff
        if (remaining < 60_000) return t('settings.time.inUnderMinute')
        if (remaining < 3600_000) return t('settings.time.inMinutes', { n: Math.floor(remaining / 60_000) })
        if (remaining < 86400_000) return t('settings.time.inHours', { n: Math.floor(remaining / 3600_000) })
        return t('settings.time.inDays', { n: Math.floor(remaining / 86400_000) })
    }

    if (diff < 60_000) return t('session.time.justNow')
    if (diff < 3600_000) return t('session.time.minutesAgo', { n: Math.floor(diff / 60_000) })
    if (diff < 86400_000) return t('session.time.hoursAgo', { n: Math.floor(diff / 3600_000) })

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

const PERMISSION_PRESETS: { id: string; permissions: ApiKeyPermission[] }[] = [
    { id: 'none', permissions: [] },
    { id: 'readOnly', permissions: ['sessions:read', 'machines:read'] },
    { id: 'vibeCoder', permissions: ['sessions:read', 'sessions:write', 'machines:read'] },
    { id: 'runner', permissions: ['sessions:write', 'machines:write'] },
    { id: 'admin', permissions: ['admin'] },
]

function PermissionPresetButtons(props: { selected: ApiKeyPermission[]; onSelect: (permissions: ApiKeyPermission[]) => void }) {
    const { t } = useTranslation()
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
                        key={preset.id}
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
                        {t(`settings.apiKeys.preset.${preset.id}`)}
                    </button>
                )
            })}
        </div>
    )
}

function PermissionsCheckboxes(props: { selected: ApiKeyPermission[]; onToggle: (p: ApiKeyPermission) => void }) {
    const { t } = useTranslation()
    return props.selected.includes('admin') ? (
        <div className="rounded px-3 py-2 bg-red-500/10 border border-red-400/20 text-xs text-red-400">
            {t('settings.apiKeys.fullAccess')}
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
                        <div className="text-xs text-[var(--app-fg)]">{t(`settings.apiKeys.perm.${p.key}`)}</div>
                        <div className="text-[10px] text-[var(--app-hint)]">{t(`settings.apiKeys.perm.${p.key}.description`)}</div>
                    </div>
                </label>
            ))}
        </div>
    )
}

// --- Shared expiry options ---
type ExpiresIn = '1d' | '7d' | '30d' | 'never'
const EXPIRY_OPTIONS: ExpiresIn[] = ['1d', '7d', '30d', 'never']

function ExpirySelector(props: { value: ExpiresIn; onChange: (v: ExpiresIn) => void }) {
    const { t } = useTranslation()
    return (
        <div className="flex gap-1">
            {EXPIRY_OPTIONS.map(value => (
                <button
                    key={value}
                    type="button"
                    onClick={() => props.onChange(value)}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium border transition-colors ${
                        props.value === value
                            ? value === 'never'
                                ? 'border-orange-400/50 bg-orange-500/15 text-orange-400'
                                : 'border-[var(--app-link)] bg-[var(--app-link)]/10 text-[var(--app-link)]'
                            : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:border-[var(--app-link)]'
                    }`}
                >
                    {t(`settings.apiKeys.expiry.${value}`)}
                </button>
            ))}
        </div>
    )
}

// --- Shared "copy raw key/token" display ---
function CreatedSecretDisplay(props: { label: string; secret: string; onDone: () => void }) {
    const { t } = useTranslation()
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
            <div className="text-[10px] text-[var(--app-hint)] mb-1.5">{t('settings.apiKeys.copyNow')}</div>
            <div className="flex items-center gap-1.5">
                <code className="flex-1 rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)] px-2 py-1 text-[10px] font-mono text-[var(--app-fg)] break-all select-all">
                    {props.secret}
                </code>
                <button type="button" onClick={handleCopy} className="shrink-0 p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]" title={t('button.copy')}>
                    {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
            </div>
            <button type="button" onClick={props.onDone} className="mt-1.5 rounded px-2.5 py-1 text-[10px] text-[var(--app-hint)] border border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)]">
                {t('settings.action.done')}
            </button>
        </div>
    )
}

// --- Confirm/Cancel inline ---
function ConfirmAction(props: { onConfirm: () => void; onCancel: () => void; label: string; pending: boolean }) {
    const { t } = useTranslation()
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
                {t('button.cancel')}
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
    const { t } = useTranslation()
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
                        {isRevoked ? t('settings.apiKeys.revoked') : isExpired ? t('settings.apiKeys.expired') : neverExpires ? t('settings.apiKeys.neverExpires') : t('settings.apiKeys.expires', { time: formatTime(token.expiresAt, t) })}
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
                        {t('settings.action.restore')}
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => onEdit(token)}
                            className="rounded p-1 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                            title={t('settings.action.edit')}
                        >
                            <EditIcon size={12} />
                        </button>
                        <button
                            type="button"
                            onClick={() => onRevoke({ apiKeyId, tokenId: token.id })}
                            disabled={revoking}
                            className="rounded px-2 py-1 text-[10px] font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                            {t('settings.action.revoke')}
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
    const { t } = useTranslation()
    const [name, setName] = useState(props.initialName)
    const [expiresIn, setExpiresIn] = useState<ExpiresIn>(props.initialExpiresIn)

    return (
        <div className="px-3 py-2 border-b border-[var(--app-divider)]">
            <div className="space-y-2">
                <input
                    type="text"
                    placeholder={t('settings.apiKeys.tokenName')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && name.trim() && props.onSubmit(name.trim(), expiresIn)}
                    className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]"
                />
                <div>
                    <div className="text-[10px] text-[var(--app-hint)] mb-1">{t('settings.apiKeys.expiry')}</div>
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
                        {t('button.cancel')}
                    </button>
                </div>
            </div>
        </div>
    )
}

// ========== Access Tokens List ==========
function AccessTokensList(props: { apiKeyId: string }) {
    const { t } = useTranslation()
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
        return <div className="px-3 py-2 text-xs text-[var(--app-hint)]">{t('settings.apiKeys.loadingTokens')}</div>
    }

    return (
        <div className="border-t border-[var(--app-divider)]">
            {/* Create form */}
            {mode === 'create' && !createdRawToken && (
                <TokenForm
                    initialName=""
                    initialExpiresIn="7d"
                    submitLabel={t('settings.action.create')}
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
                    submitLabel={t('button.save')}
                    onSubmit={handleEdit}
                    onCancel={closeForm}
                    pending={updateMutation.isPending}
                />
            )}

            {/* Created token display */}
            {createdRawToken && (
                <CreatedSecretDisplay label={t('settings.apiKeys.tokenCreated')} secret={createdRawToken} onDone={closeForm} />
            )}

            {/* Token list */}
            {tokens.length === 0 && mode === 'idle' && (
                <div className="px-3 py-2 text-xs text-[var(--app-hint)]">{t('settings.apiKeys.noTokens')}</div>
            )}
            {tokens.map(token => (
                <TokenRow
                    key={token.id}
                    token={token}
                    apiKeyId={props.apiKeyId}
                    onEdit={(item) => { setEditingToken(item); setMode('edit') }}
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
                    {t('settings.apiKeys.newToken')}
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
    const { t } = useTranslation()
    const [name, setName] = useState(props.initialName)
    const [permissions, setPermissions] = useState<ApiKeyPermission[]>(props.initialPermissions)

    const toggle = (p: ApiKeyPermission) => {
        setPermissions(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
    }

    return (
        <div className="px-3 py-2 bg-[var(--app-subtle-bg)] rounded-lg mt-1 mb-2">
            <div className="space-y-2">
                <div>
                    <div className="text-xs text-[var(--app-hint)] mb-1">{t('settings.field.name')}</div>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('settings.apiKeys.keyName')}
                        className="w-full rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:border-[var(--app-link)]"
                    />
                </div>
                <div>
                    <div className="text-xs text-[var(--app-hint)] mb-1.5">{t('settings.apiKeys.permissions')}</div>
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
                        {t('button.cancel')}
                    </button>
                </div>
            </div>
        </div>
    )
}

// ========== Main Page ==========
export default function ApiKeysPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
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
                                <span className="text-xs text-[var(--app-hint)]">· {t('settings.apiKeys.used', { time: formatTime(key.lastUsedAt, t) })}</span>
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
                                {t('settings.action.restore')}
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setEditingKeyId(isEditing ? null : key.id)}
                                    className="rounded p-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                                    title={t('settings.action.edit')}
                                >
                                    <EditIcon />
                                </button>
                                {confirmRevokeId === key.id ? (
                                    <ConfirmAction
                                        onConfirm={() => handleRevoke(key.id)}
                                        onCancel={() => setConfirmRevokeId(null)}
                                        label={t('button.confirm')}
                                        pending={revokeMutation.isPending}
                                    />
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setConfirmRevokeId(key.id)}
                                        className="rounded px-2 py-1 text-xs text-[var(--app-hint)] hover:text-red-400 hover:bg-red-500/10"
                                    >
                                        {t('settings.action.revoke')}
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
                            submitLabel={t('button.save')}
                            onSubmit={(name, perms) => handleUpdate(key.id, name, perms)}
                            onCancel={() => setEditingKeyId(null)}
                            pending={updateMutation.isPending}
                        />
                    </div>
                )}
                {isExpanded && !isRevoked && (
                    <div className="ml-6 mb-2 bg-[var(--app-subtle-bg)] rounded-lg overflow-hidden">
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.apiKeys.accessTokens')}
                        </div>
                        <AccessTokensList apiKeyId={key.id} />
                    </div>
                )}
            </div>
        )
    }

    return (
        <SettingsScreen
            title={t('settings.nav.apiKeys')}
            action={(
                <button type="button" onClick={() => { setShowForm(true); setCreatedKey(null) }} className={headerIconButtonClass} title={t('settings.apiKeys.create')}>
                    <PlusIcon />
                </button>
            )}
        >
            {isLoading && (
                <div className="px-3 py-8 text-center text-[var(--app-hint)]">{t('misc.loading')}</div>
            )}

            {/* Create Form */}
            {showForm && !createdKey && (
                <div className="border-b border-[var(--app-divider)] px-3 py-3">
                    <div className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide mb-2">
                        {t('settings.apiKeys.newKey')}
                    </div>
                    <ApiKeyEditForm
                        initialName=""
                        initialPermissions={[]}
                        submitLabel={t('settings.action.create')}
                        onSubmit={handleCreate}
                        onCancel={closeForm}
                        pending={createMutation.isPending}
                    />
                </div>
            )}

            {/* Created Key Display */}
            {createdKey && (
                <CreatedSecretDisplay label={t('settings.apiKeys.keyCreated')} secret={createdKey} onDone={closeForm} />
            )}

            {/* Active Keys */}
            {!isLoading && (
                <div className="border-b border-[var(--app-divider)]">
                    <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                        {t('settings.apiKeys.active', { n: activeKeys.length })}
                    </div>
                    {activeKeys.length === 0 ? (
                        <div className="px-3 py-4 text-sm text-[var(--app-hint)]">
                            {t('settings.apiKeys.noActive')}
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
                        {t('settings.apiKeys.revokedList', { n: revokedKeys.length })}
                    </div>
                    {revokedKeys.map(renderKeyRow)}
                </div>
            )}
        </SettingsScreen>
    )
}
