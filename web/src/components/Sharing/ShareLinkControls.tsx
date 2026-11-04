import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'

export function ShareLinkControls({
    shared,
    url,
    onToggle,
    disabled = false
}: {
    shared: boolean
    url: string | null
    onToggle: () => void
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const { copied, copy } = useCopyToClipboard()
    return (
        <div>
            <div className="flex items-center justify-between">
                <span className="text-sm">{t('dialog.properties.shared')}</span>
                <button
                    type="button"
                    role="switch"
                    aria-label={t('dialog.properties.shared')}
                    aria-checked={shared}
                    onClick={onToggle}
                    disabled={disabled}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-40 ${shared ? 'bg-[var(--app-button)]' : 'bg-[var(--app-border)]'}`}
                >
                    <span
                        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${shared ? 'translate-x-5' : 'translate-x-0'}`}
                    />
                </button>
            </div>
            {url && (
                <div className="mt-2 flex items-center gap-2">
                    <input
                        aria-label={t('shared.copyLink')}
                        readOnly
                        value={url}
                        onClick={event => event.currentTarget.select()}
                        className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs"
                    />
                    <button
                        type="button"
                        onClick={() => void copy(url)}
                        className="shrink-0 rounded-md bg-[var(--app-secondary-bg)] px-2.5 py-2 text-xs font-medium text-[var(--app-fg)] hover:opacity-90"
                    >
                        {copied ? t('share.copied') : t('button.copy')}
                    </button>
                </div>
            )}
        </div>
    )
}
