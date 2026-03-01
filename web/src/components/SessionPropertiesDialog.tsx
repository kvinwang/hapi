import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ApiClient } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'

type SessionPropertiesDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    sessionName: string
    pinned: boolean
    shared: boolean
    tags: string[]
    api: ApiClient | null
    onRename: (name: string) => Promise<void>
    onTogglePin: () => void
    onShare?: () => void
    onUnshare?: () => void
}

const PREDEFINED_TAGS = ['no-search'] as const

export function SessionPropertiesDialog(props: SessionPropertiesDialogProps) {
    const { t } = useTranslation()
    const {
        isOpen, onClose, sessionId,
        sessionName, pinned, shared,
        tags: initialTags, api,
        onRename, onTogglePin, onShare, onUnshare
    } = props
    const queryClient = useQueryClient()
    const [name, setName] = useState(sessionName)
    const [tags, setTags] = useState<string[]>(initialTags)
    const [tagInput, setTagInput] = useState('')
    const [systemPrompt, setSystemPrompt] = useState('')
    const [initialSystemPrompt, setInitialSystemPrompt] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const nameRef = useRef<HTMLInputElement>(null)
    const dialogInitialized = useRef(false)
    const systemPromptInitialized = useRef(false)

    const { data: uiState } = useQuery({
        queryKey: queryKeys.sessionUiState(sessionId),
        queryFn: () => api!.getSessionUiState(sessionId),
        enabled: isOpen && !!api
    })

    const { data: preferences } = useQuery({
        queryKey: queryKeys.preferences,
        queryFn: () => api!.getPreferences(),
        enabled: isOpen && !!api
    })

    const [useCustomPrompt, setUseCustomPrompt] = useState(false)

    const shareUrl = shared ? `${window.location.origin}/shared/${sessionId}` : null

    const handleCopyLink = useCallback(async () => {
        if (!shareUrl) return
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [shareUrl])

    useEffect(() => {
        if (isOpen && !dialogInitialized.current) {
            setName(sessionName)
            setTags(initialTags)
            setTagInput('')
            setError(null)
            setCopied(false)
            systemPromptInitialized.current = false
            setUseCustomPrompt(false)
            dialogInitialized.current = true
        }
        if (!isOpen) {
            dialogInitialized.current = false
        }
    }, [isOpen, sessionName, initialTags])

    // Initialize system prompt from uiState only once after dialog opens
    useEffect(() => {
        if (isOpen && uiState && !systemPromptInitialized.current) {
            const sp = uiState.systemPrompt ?? ''
            setSystemPrompt(sp)
            setInitialSystemPrompt(sp)
            setUseCustomPrompt(Boolean(sp))
            systemPromptInitialized.current = true
        }
    }, [isOpen, uiState])

    const addTag = (tag: string) => {
        const trimmed = tag.trim().toLowerCase()
        if (!trimmed) return
        if (tags.includes(trimmed)) return
        if (tags.length >= 20) {
            setError(t('dialog.properties.maxTags'))
            return
        }
        if (trimmed.length > 50) {
            setError(t('dialog.properties.tagTooLong'))
            return
        }
        setTags([...tags, trimmed])
        setTagInput('')
        setError(null)
    }

    const removeTag = (tag: string) => {
        setTags(tags.filter(t => t !== tag))
    }

    const handleTagKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            addTag(tagInput)
        }
    }

    const nameChanged = name.trim() !== '' && name.trim() !== sessionName
    const tagsChanged = JSON.stringify(tags.slice().sort()) !== JSON.stringify(initialTags.slice().sort())
    // Determine effective system prompt value for saving
    const effectivePrompt = useCustomPrompt ? systemPrompt : ''
    const systemPromptChanged = effectivePrompt !== initialSystemPrompt
    const hasChanges = nameChanged || tagsChanged || systemPromptChanged

    const handleSave = async () => {
        if (!api) return
        setSaving(true)
        setError(null)
        try {
            if (nameChanged) {
                await onRename(name.trim())
            }
            const uiUpdates: Record<string, unknown> = {}
            if (tagsChanged) uiUpdates.tags = tags
            if (systemPromptChanged) {
                // When toggle is OFF, save empty string so hub falls back to global
                uiUpdates.systemPrompt = useCustomPrompt ? (systemPrompt || undefined) : ''
            }
            if (Object.keys(uiUpdates).length > 0) {
                await api.updateSessionUiState(sessionId, uiUpdates)
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessionUiState(sessionId) })
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            onClose()
        } catch {
            setError(t('dialog.properties.error'))
        } finally {
            setSaving(false)
        }
    }

    const inputClassName = 'w-full px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent text-sm'

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.properties.title')}</DialogTitle>
                </DialogHeader>
                <div className="mt-4 flex flex-col gap-5">
                    {/* Name */}
                    <div>
                        <label className="text-xs font-medium text-[var(--app-hint)]">
                            {t('dialog.properties.name')}
                        </label>
                        <input
                            ref={nameRef}
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className={`mt-1.5 ${inputClassName}`}
                            disabled={saving}
                            maxLength={255}
                        />
                    </div>

                    {/* Toggles row */}
                    <div className="flex flex-col gap-3">
                        {/* Pin toggle */}
                        <div className="flex items-center justify-between">
                            <span className="text-sm">{t('dialog.properties.pinned')}</span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={pinned}
                                onClick={onTogglePin}
                                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${pinned ? 'bg-[var(--app-button)]' : 'bg-[var(--app-border)]'}`}
                                disabled={saving}
                            >
                                <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${pinned ? 'translate-x-5' : 'translate-x-0'}`} />
                            </button>
                        </div>

                        {/* Share toggle */}
                        {(onShare || onUnshare) ? (
                            <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm">{t('dialog.properties.shared')}</span>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={shared}
                                        onClick={() => shared ? onUnshare?.() : onShare?.()}
                                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${shared ? 'bg-[var(--app-button)]' : 'bg-[var(--app-border)]'}`}
                                        disabled={saving}
                                    >
                                        <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${shared ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                                {shareUrl ? (
                                    <div className="mt-2 flex items-center gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={shareUrl}
                                            className={`${inputClassName} text-xs`}
                                            onClick={(e) => (e.target as HTMLInputElement).select()}
                                        />
                                        <button
                                            type="button"
                                            onClick={handleCopyLink}
                                            className="shrink-0 rounded-md px-2.5 py-2 text-xs font-medium bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:opacity-90 transition-colors"
                                        >
                                            {copied ? t('share.copied') : t('button.copy')}
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </div>

                    {/* Tags */}
                    <div>
                        <label className="text-xs font-medium text-[var(--app-hint)]">
                            {t('dialog.properties.tags')}
                        </label>
                        <input
                            type="text"
                            value={tagInput}
                            onChange={(e) => setTagInput(e.target.value)}
                            onKeyDown={handleTagKeyDown}
                            placeholder={t('dialog.properties.addTag')}
                            className={`mt-1.5 ${inputClassName}`}
                            disabled={saving}
                        />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {tags.map((tag) => (
                                <span
                                    key={tag}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--app-subtle-bg)] text-sm"
                                >
                                    {tag}
                                    <button
                                        type="button"
                                        onClick={() => removeTag(tag)}
                                        className="ml-0.5 text-[var(--app-hint)] hover:text-red-500 transition-colors"
                                        disabled={saving}
                                    >
                                        &times;
                                    </button>
                                </span>
                            ))}
                            {tags.length === 0 ? (
                                <span className="text-sm text-[var(--app-hint)]">
                                    {t('dialog.properties.noTags')}
                                </span>
                            ) : null}
                        </div>
                        {/* Predefined tags */}
                        {(() => {
                            const suggestions = PREDEFINED_TAGS.filter(t => !tags.includes(t))
                            if (suggestions.length === 0) return null
                            return (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {suggestions.map((tag) => (
                                        <button
                                            key={tag}
                                            type="button"
                                            onClick={() => addTag(tag)}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-dashed border-[var(--app-border)] text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                                            disabled={saving}
                                        >
                                            + {tag}
                                        </button>
                                    ))}
                                </div>
                            )
                        })()}
                    </div>

                    {/* System Prompt */}
                    <div>
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-[var(--app-hint)]">
                                {t('dialog.properties.systemPrompt')}
                            </label>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={useCustomPrompt}
                                onClick={() => {
                                    if (useCustomPrompt) {
                                        setUseCustomPrompt(false)
                                        setSystemPrompt('')
                                    } else {
                                        setUseCustomPrompt(true)
                                        if (!systemPrompt) {
                                            setSystemPrompt(preferences?.systemPrompt ?? '')
                                        }
                                    }
                                }}
                                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${useCustomPrompt ? 'bg-[var(--app-button)]' : 'bg-[var(--app-border)]'}`}
                                disabled={saving}
                            >
                                <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${useCustomPrompt ? 'translate-x-5' : 'translate-x-0'}`} />
                            </button>
                        </div>
                        {!useCustomPrompt && preferences?.systemPrompt ? (
                            <p className="mt-1 text-xs text-[var(--app-hint)]">
                                {t('dialog.properties.usingGlobalPrompt')}
                            </p>
                        ) : null}
                        {useCustomPrompt ? (
                            <textarea
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                placeholder={t('dialog.properties.systemPromptPlaceholder')}
                                className={`mt-1.5 ${inputClassName} min-h-[80px] max-h-[200px] resize-y`}
                                disabled={saving}
                                maxLength={10000}
                                rows={3}
                            />
                        ) : null}
                    </div>

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex gap-2 justify-end">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={onClose}
                            disabled={saving}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleSave}
                            disabled={saving || !hasChanges}
                        >
                            {saving ? t('dialog.properties.saving') : t('button.save')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
