import type { PullToRefreshState } from '@/hooks/usePullToRefresh'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function ArrowDownIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
    return (
        <svg className={className} style={style} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 4v14m0 0 5-5m-5 5-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function CheckIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m5 13 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

/**
 * Status strip for {@link usePullToRefresh}. Render it as the first child of the scroll container:
 * its height mirrors the pull distance, so the list is pushed down as the user drags.
 */
export function PullToRefreshIndicator({ state }: { state: PullToRefreshState }) {
    const { t } = useTranslation()
    const { phase, distance, progress, animating } = state

    if (phase === 'idle' && distance <= 0) return null

    const label = phase === 'refreshing'
        ? t('sessions.refreshing')
        : phase === 'done'
            ? t('sessions.refreshed')
            : phase === 'ready'
                ? t('sessions.releaseToRefresh')
                : t('sessions.pullToRefresh')

    return (
        <div
            className="overflow-hidden"
            style={{
                height: `${distance}px`,
                transition: animating ? 'height 220ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
            }}
        >
            <div className="flex h-full items-end justify-center gap-2 pb-2 text-xs text-[var(--app-hint)]">
                {phase === 'refreshing' ? (
                    <Spinner size="sm" className="h-4 w-4" label={null} />
                ) : phase === 'done' ? (
                    <CheckIcon className="h-4 w-4 text-[var(--app-link)]" />
                ) : (
                    // Flip the arrow once the pull is armed; fade it in with the drag.
                    <ArrowDownIcon
                        className="h-4 w-4 transition-transform duration-200"
                        style={{
                            transform: phase === 'ready' ? 'rotate(180deg)' : 'rotate(0deg)',
                            opacity: 0.35 + progress * 0.65,
                        }}
                    />
                )}
                <span role="status" aria-live="polite" className="whitespace-nowrap">{label}</span>
            </div>
        </div>
    )
}
