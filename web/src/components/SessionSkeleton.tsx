import { isTelegramApp } from '@/hooks/useTelegram'
import { useTranslation } from '@/lib/use-translation'

function BackChevronIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

/**
 * Shown while a session the user has never opened is still loading and the sessions list holds no
 * summary to paint from (deep link, or a cold start with an empty cache).
 *
 * The point is that the frame arrives immediately: a working back button plus the same header and
 * message geometry the real page uses, so the transition into `SessionChat` does not jump.
 */
export function SessionSkeleton(props: { onBack: () => void; title?: string }) {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-2/3', height: 'h-10' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-5/6', height: 'h-14' }
    ]

    return (
        <div className="flex-1 flex flex-col min-h-0" role="status" aria-live="polite">
            <span className="sr-only">{t('loading')}</span>

            {isTelegramApp() ? null : (
                <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                    <div className="w-full flex items-center gap-2 p-3">
                        <button
                            type="button"
                            onClick={props.onBack}
                            aria-label={t('session.back')}
                            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <BackChevronIcon />
                        </button>
                        <div className="min-w-0 flex-1 animate-pulse">
                            <div className="mb-1 h-3 w-24 rounded bg-[var(--app-subtle-bg)]" />
                            {props.title ? (
                                <div className="truncate font-semibold">{props.title}</div>
                            ) : (
                                <div className="mb-1 h-4 w-40 rounded bg-[var(--app-subtle-bg)]" />
                            )}
                            <div className="h-3 w-56 rounded bg-[var(--app-subtle-bg)]" />
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-hidden p-4">
                <div className="space-y-3 animate-pulse">
                    {rows.map((row, index) => (
                        <div
                            key={`session-skeleton-${index}`}
                            className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}
                        >
                            <div className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`} />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
