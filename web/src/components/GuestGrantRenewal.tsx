import { useState } from 'react'
import { GuestExpirySchema, type GuestExpiry } from '@hapi/protocol/threads'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

/** A guest grant's expiry and its renewal, which counts from now and also revives an expired grant. */
export function GuestGrantRenewal({ expiresAt, pending, onRenew }: { expiresAt: number; pending: boolean; onRenew: (expiresIn: GuestExpiry) => void }) {
    const { t } = useTranslation()
    const [expiresIn, setExpiresIn] = useState<GuestExpiry>('1d')
    const expired = expiresAt <= Date.now()
    return (
        <span className="flex flex-wrap items-center gap-1">
            <span className={expired ? 'text-red-500' : 'text-[var(--app-hint)]'}>
                {t(expired ? 'guest.access.expiredAt' : 'guest.access.expiresAt', { time: new Date(expiresAt).toLocaleString() })}
            </span>
            <select
                aria-label={t('guest.access.renewFor')}
                value={expiresIn}
                onChange={e => setExpiresIn(e.target.value as GuestExpiry)}
                className="rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-1 py-0.5"
            >
                {GuestExpirySchema.options.map(option => <option key={option} value={option}>{t(`guest.access.expiry.${option}`)}</option>)}
            </select>
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => onRenew(expiresIn)}>
                {t('guest.access.renew')}
            </Button>
        </span>
    )
}
