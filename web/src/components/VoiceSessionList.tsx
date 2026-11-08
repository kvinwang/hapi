import { useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { SessionList } from './SessionList'

/** Reuse the native session cards; the frozen order also defines spoken selection numbers. */
export function VoiceSessionList({ api, sessions, search, onSelect, onCancel }: {
    api: ApiClient
    sessions: SessionSummary[]
    search: string
    onSelect: (index: number) => void
    onCancel: () => void
}) {
    const { t } = useTranslation()
    const order = useMemo(() => sessions.map(session => session.id), [sessions])
    const indices = useMemo(() => new Map(order.map((id, index) => [id, index + 1])), [order])
    return (
        <div className="flex min-h-0 flex-1 flex-col bg-[var(--app-bg)]">
            <div className="flex items-center justify-between gap-2 border-b border-[var(--app-divider)] p-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <span className="text-sm font-medium">{search ? t('voice.ui.matchingSessions', { query: search }) : t('voice.ui.sessions')}</span>
                <button type="button" className="shrink-0 text-sm text-[var(--app-link)]" onClick={onCancel}>{t('voice.ui.cancelSelection')}</button>
            </div>
            <div className="app-scroll-y min-h-0 flex-1">
                {sessions.length ? <SessionList api={api} sessions={sessions} selectionOrder={order} viewMode="flat"
                    onSelect={id => { const index = indices.get(id); if (index !== undefined) onSelect(index) }}
                    isLoading={false} renderHeader={false} />
                    : <p className="p-4 text-sm text-[var(--app-hint)]">{t(search ? 'voice.ui.noMatchingSessions' : 'voice.ui.noSessions')}</p>}
            </div>
        </div>
    )
}
