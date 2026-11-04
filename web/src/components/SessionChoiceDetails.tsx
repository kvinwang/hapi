import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

export function SessionChoiceDetails({ session, index }: { session: SessionSummary; index?: number }) {
    const { t } = useTranslation()
    const title = session.metadata?.name || session.metadata?.summary?.text || session.metadata?.path || session.id
    return (
        <>
            <div className="truncate font-medium">
                {index !== undefined ? `${index}. ` : ''}
                {title}
            </div>
            {session.activity && (
                <div className="truncate text-xs" title={session.activity.text}>
                    {t(
                        session.activity.source === 'summary' ? 'sessions.recentActivity' : 'sessions.latestUserMessage'
                    )}
                    : {session.activity.text}
                </div>
            )}
            {session.parentSessionId || session.metadata?.subagent ? (
                <span className="text-xs text-[var(--app-hint)]">{t('voice.ui.childSession')}</span>
            ) : null}
            <div className="break-all text-xs text-[var(--app-hint)]">
                {t('voice.ui.directory')}: {session.metadata?.path || '—'}
            </div>
        </>
    )
}
