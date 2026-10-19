import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'
import type { GuestGrantExpiry } from '@/types/api'

const EXPIRY_OPTIONS: GuestGrantExpiry[] = ['1h', '1d', '7d', '30d']

export function GuestAccessDialog(props: { onClose: () => void; api: ApiClient; sessionId: string }) {
    const { api, sessionId } = props
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { copied, copy } = useCopyToClipboard()
    const [expiresIn, setExpiresIn] = useState<GuestGrantExpiry>('1d')
    const [allowVoice, setAllowVoice] = useState(false)
    const [description, setDescription] = useState('')
    const [created, setCreated] = useState<{ url: string; code: string } | null>(null)
    const [error, setError] = useState<string | null>(null)

    const queryKey = ['guest-grants', sessionId]
    const { data } = useQuery({
        queryKey,
        queryFn: () => api.listGuestGrants(sessionId)
    })
    const onError = (err: unknown) => setError(err instanceof Error ? err.message : t('dialog.error.default'))
    const onSuccess = () => {
        setError(null)
        void queryClient.invalidateQueries({ queryKey })
    }

    const create = useMutation({
        mutationFn: () => api.createGuestGrant(sessionId, { expiresIn, allowVoice, description }),
        onSuccess: ({ grant, code }) => {
            setCreated({ url: `${window.location.origin}/guest/${grant.id}`, code })
            onSuccess()
        },
        onError
    })
    const toggleVoice = useMutation({
        mutationFn: (vars: { grantId: string; allowVoice: boolean }) => api.updateGuestGrant(sessionId, vars.grantId, vars.allowVoice),
        onSuccess,
        onError
    })
    const revoke = useMutation({
        mutationFn: (grantId: string) => api.revokeGuestGrant(sessionId, grantId),
        onSuccess,
        onError
    })

    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('guest.access.title')}</DialogTitle>
                    <DialogDescription className="mt-2">{t('guest.access.description')}</DialogDescription>
                </DialogHeader>

                {created ? (
                    <div className="mt-4 space-y-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm">
                        <div className="break-all font-mono text-xs">{created.url}</div>
                        <div>
                            {t('guest.access.code')}: <span className="font-mono text-base font-semibold tracking-widest">{created.code}</span>
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">{t('guest.access.codeOnce')}</div>
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => void copy(t('guest.access.copyText', { url: created.url, code: created.code }))}
                        >
                            {copied ? t('guest.access.copied') : t('guest.access.copy')}
                        </Button>
                    </div>
                ) : (
                    <div className="mt-4 space-y-3 text-sm">
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            maxLength={200}
                            placeholder={t('guest.access.descriptionPlaceholder')}
                            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1"
                        />
                        <label className="flex items-center justify-between gap-2">
                            <span>{t('guest.access.expiresIn')}</span>
                            <select
                                value={expiresIn}
                                onChange={(e) => setExpiresIn(e.target.value as GuestGrantExpiry)}
                                className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1"
                            >
                                {EXPIRY_OPTIONS.map((option) => (
                                    <option key={option} value={option}>{t(`guest.access.expiry.${option}`)}</option>
                                ))}
                            </select>
                        </label>
                        <label className="flex items-center gap-2">
                            <input type="checkbox" checked={allowVoice} onChange={(e) => setAllowVoice(e.target.checked)} />
                            <span>{t('guest.access.allowVoice')}</span>
                        </label>
                        <Button type="button" onClick={() => create.mutate()} disabled={create.isPending}>
                            {t('guest.access.create')}
                        </Button>
                    </div>
                )}

                {error ? (
                    <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                {data && data.grants.length > 0 ? (
                    <div className="mt-4 space-y-2">
                        <div className="text-xs font-medium text-[var(--app-hint)]">{t('guest.access.active')}</div>
                        {data.grants.map((grant) => (
                            <div key={grant.id} className="flex items-center gap-2 rounded-md border border-[var(--app-border)] px-3 py-2 text-xs">
                                <div className="min-w-0 flex-1">
                                    {grant.description ? <div className="truncate">{grant.description}</div> : null}
                                    <div className="text-[var(--app-hint)]">
                                        {t('guest.access.expiresAt', { time: new Date(grant.expiresAt).toLocaleString() })}
                                    </div>
                                </div>
                                <label className="flex items-center gap-1">
                                    <input
                                        type="checkbox"
                                        checked={grant.allowVoice}
                                        disabled={toggleVoice.isPending}
                                        onChange={(e) => toggleVoice.mutate({ grantId: grant.id, allowVoice: e.target.checked })}
                                    />
                                    {t('guest.access.voice')}
                                </label>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    disabled={revoke.isPending}
                                    onClick={() => revoke.mutate(grant.id)}
                                >
                                    {t('guest.access.revoke')}
                                </Button>
                            </div>
                        ))}
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}
