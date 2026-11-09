import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThreadGuestGrant, ThreadGuestGrantInput, ThreadGuestLimits } from '@hapi/protocol/threads'
import { ThreadGuestClient } from '@/api/threadGuest'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { threadButton, threadInput } from './types'

const EXPIRY_OPTIONS = ['1h', '1d', '7d', '30d'] as const
const DEFAULT_LIMITS: ThreadGuestLimits = { messagesPerMinute: 10, maxTextLength: 8_000, wakeLimit: 20, allowEdit: false }
const LIMIT_FIELDS = [
    ['messagesPerMinute', 'thread.guest.messagesPerMinute'],
    ['maxTextLength', 'thread.guest.maxTextLength'],
    ['wakeLimit', 'thread.guest.wakeLimit']
] as const

function LimitFields({ value, onChange }: { value: ThreadGuestLimits; onChange: (value: ThreadGuestLimits) => void }) {
    const { t } = useTranslation()
    return (
        <>
            {LIMIT_FIELDS.map(([key, label]) => (
                <label key={key} className="flex items-center justify-between gap-2">
                    <span>{t(label)}</span>
                    <input
                        type="number"
                        min={0}
                        value={value[key]}
                        onChange={e => onChange({ ...value, [key]: Number(e.target.value) })}
                        className="w-24 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1"
                    />
                </label>
            ))}
            <label className="flex items-center gap-2">
                <input type="checkbox" checked={value.allowEdit} onChange={e => onChange({ ...value, allowEdit: e.target.checked })} />
                <span>{t('thread.guest.allowEdit')}</span>
            </label>
        </>
    )
}

function GuestRow({ threadId, grant, onError }: { threadId: string; grant: ThreadGuestGrant; onError: (error: unknown) => void }) {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const client = useQueryClient()
    const [limits, setLimits] = useState<ThreadGuestLimits>(grant)
    const refresh = () => client.invalidateQueries({ queryKey: ['threads'] })
    const save = useMutation({ mutationFn: () => api.updateThreadGuest(threadId, grant.id, limits), onSuccess: refresh, onError })
    const revoke = useMutation({ mutationFn: () => api.revokeThreadGuest(threadId, grant.id), onSuccess: refresh, onError })
    const dirty = LIMIT_FIELDS.some(([key]) => limits[key] !== grant[key]) || limits.allowEdit !== grant.allowEdit
    return (
        <li className="space-y-2 rounded-md border border-[var(--app-divider)] p-3 text-xs">
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{grant.name}</div>
                    <div className="text-[var(--app-hint)]">
                        {t('guest.access.expiresAt', { time: new Date(grant.expiresAt).toLocaleString() })} ·{' '}
                        {t('thread.guest.wakes', { used: grant.wakeCount, limit: grant.wakeLimit })} ·{' '}
                        {t(grant.redeemed ? 'thread.guest.redeemed' : 'thread.guest.unredeemed')}
                    </div>
                </div>
                <Button type="button" size="sm" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                    {t('guest.access.revoke')}
                </Button>
            </div>
            <LimitFields value={limits} onChange={setLimits} />
            {dirty && (
                <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                    {t('thread.guest.save')}
                </Button>
            )}
        </li>
    )
}

export function ThreadGuestDialog({ threadId, open, onOpenChange }: { threadId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { api, baseUrl } = useAppContext()
    const { t } = useTranslation()
    const client = useQueryClient()
    const { copied, copy } = useCopyToClipboard()
    const [form, setForm] = useState<ThreadGuestGrantInput & ThreadGuestLimits>({ name: '', expiresIn: '1d', includeHistory: false, ...DEFAULT_LIMITS })
    const [created, setCreated] = useState<{ text: string; code: string } | null>(null)
    const [error, setError] = useState('')
    const onError = (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    const grants = useQuery({
        queryKey: ['threads', threadId, 'guests'],
        queryFn: () => api.listThreadGuests(threadId),
        enabled: open
    })
    const create = useMutation({
        mutationFn: () => api.createThreadGuest(threadId, form),
        onSuccess: ({ grant, code }) => {
            setError('')
            const origin = baseUrl || window.location.origin
            const url = new URL(`/thread-guest/${encodeURIComponent(grant.id)}`, origin).href
            setCreated({ code, text: t('thread.guest.copyText', { name: grant.name, url, code, guide: ThreadGuestClient.guideUrl(origin, grant.id) }) })
            void client.invalidateQueries({ queryKey: ['threads'] })
        },
        onError
    })
    return (
        <Dialog open={open} onOpenChange={value => {
            if (!value) setCreated(null)
            onOpenChange(value)
        }}>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
                <div className="mb-3 flex items-center justify-between">
                    <DialogTitle>{t('thread.guest.title')}</DialogTitle>
                    <button className={threadButton} aria-label={t('session.threads.close')} onClick={() => onOpenChange(false)}>✕</button>
                </div>
                <DialogDescription className="mb-4">{t('thread.guest.description')}</DialogDescription>
                {created ? (
                    <div className="space-y-2 rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] p-3 text-sm">
                        <pre className="whitespace-pre-wrap break-all font-mono text-xs">{created.text}</pre>
                        <div className="text-xs text-[var(--app-hint)]">{t('guest.access.codeOnce')}</div>
                        <Button type="button" size="sm" onClick={() => void copy(created.text)}>
                            {copied ? t('guest.access.copied') : t('thread.guest.copy')}
                        </Button>
                    </div>
                ) : (
                    <form className="space-y-3 text-sm" onSubmit={e => {
                        e.preventDefault()
                        create.mutate()
                    }}>
                        <input
                            className={threadInput}
                            value={form.name}
                            maxLength={60}
                            required
                            placeholder={t('thread.guest.name')}
                            onChange={e => setForm({ ...form, name: e.target.value })}
                        />
                        <label className="flex items-center justify-between gap-2">
                            <span>{t('guest.access.expiresIn')}</span>
                            <select
                                value={form.expiresIn}
                                onChange={e => setForm({ ...form, expiresIn: e.target.value as typeof EXPIRY_OPTIONS[number] })}
                                className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1"
                            >
                                {EXPIRY_OPTIONS.map(option => <option key={option} value={option}>{t(`guest.access.expiry.${option}`)}</option>)}
                            </select>
                        </label>
                        <label className="flex items-center gap-2">
                            <input type="checkbox" checked={form.includeHistory} onChange={e => setForm({ ...form, includeHistory: e.target.checked })} />
                            <span>{t('thread.guest.includeHistory')}</span>
                        </label>
                        <LimitFields value={form} onChange={limits => setForm({ ...form, ...limits })} />
                        <Button type="submit" disabled={create.isPending || !form.name.trim()}>{t('thread.guest.create')}</Button>
                    </form>
                )}
                {(error || grants.error) && <p role="alert" className="mt-3 text-sm text-red-500">{error || grants.error?.message}</p>}
                {!!grants.data?.grants.length && (
                    <section className="mt-4 space-y-2">
                        <h3 className="text-xs font-medium text-[var(--app-hint)]">{t('thread.guest.active')}</h3>
                        <ul className="space-y-2">
                            {grants.data.grants.map(grant => <GuestRow key={`${grant.id}:${grant.wakeLimit}:${grant.messagesPerMinute}:${grant.maxTextLength}:${grant.allowEdit}`} threadId={threadId} grant={grant} onError={onError} />)}
                        </ul>
                    </section>
                )}
            </DialogContent>
        </Dialog>
    )
}
