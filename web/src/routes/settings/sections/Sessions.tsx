import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { selectStaleSessions } from '@/lib/stale-sessions'
import { SettingsSection } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'

const actionButtonClass = 'w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50'

export default function SessionsSettings() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const [pruneState, setPruneState] = useState<
        { kind: 'idle' }
        | { kind: 'checking' }
        | { kind: 'confirm'; found: number }
        | { kind: 'deleting'; found: number }
        | { kind: 'done'; deleted: number; failed: number }
        | { kind: 'error'; message: string }
    >({ kind: 'idle' })
    const [closeStaleState, setCloseStaleState] = useState<
        { kind: 'idle' }
        | { kind: 'checking' }
        | { kind: 'confirm'; ids: string[] }
        | { kind: 'running'; total: number; processed: number; closed: number; failed: number }
        | { kind: 'done'; total: number; closed: number; failed: number; stopped: boolean }
        | { kind: 'error'; message: string }
    >({ kind: 'idle' })
    const stopCloseStaleRef = useRef(false)

    // Count first, ask, then delete: a cleanup nobody can preview is a cleanup
    // nobody dares run.
    const countEmptySessions = useCallback(async () => {
        setPruneState({ kind: 'checking' })
        try {
            const result = await api.pruneEmptySessions(true)
            setPruneState(result.found === 0
                ? { kind: 'done', deleted: 0, failed: 0 }
                : { kind: 'confirm', found: result.found })
        } catch (error) {
            setPruneState({ kind: 'error', message: error instanceof Error ? error.message : 'Failed' })
        }
    }, [api])

    const deleteEmptySessions = useCallback(async () => {
        setPruneState((prev) => ({ kind: 'deleting', found: prev.kind === 'confirm' ? prev.found : 0 }))
        try {
            const result = await api.pruneEmptySessions(false)
            setPruneState({ kind: 'done', deleted: result.deleted, failed: result.failed })
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        } catch (error) {
            setPruneState({ kind: 'error', message: error instanceof Error ? error.message : 'Failed' })
        }
    }, [api, queryClient])

    // Always read a fresh list: the cached one can lag behind by a few minutes.
    const findStaleSessions = useCallback(async () => {
        setCloseStaleState({ kind: 'checking' })
        try {
            const { sessions } = await api.getSessions()
            const ids = selectStaleSessions(sessions, Date.now()).map((session) => session.id)
            setCloseStaleState(ids.length === 0
                ? { kind: 'done', total: 0, closed: 0, failed: 0, stopped: false }
                : { kind: 'confirm', ids })
        } catch (error) {
            setCloseStaleState({ kind: 'error', message: error instanceof Error ? error.message : 'Failed' })
        }
    }, [api])

    // One archive call at a time so progress is exact and the hub is not flooded.
    const closeStaleSessions = useCallback(async (ids: string[]) => {
        stopCloseStaleRef.current = false
        let processed = 0
        let closed = 0
        let failed = 0
        setCloseStaleState({ kind: 'running', total: ids.length, processed, closed, failed })
        for (const id of ids) {
            if (stopCloseStaleRef.current) break
            try {
                await api.archiveSession(id)
                closed += 1
            } catch {
                failed += 1
            }
            processed += 1
            setCloseStaleState({ kind: 'running', total: ids.length, processed, closed, failed })
        }
        setCloseStaleState({
            kind: 'done',
            total: ids.length,
            closed,
            failed,
            stopped: processed < ids.length
        })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }, [api, queryClient])

    return (
        <SettingsScreen title={t('settings.section.sessions')}>
            <ConfirmDialog
                isOpen={pruneState.kind === 'confirm' || pruneState.kind === 'deleting'}
                onClose={() => setPruneState((prev) => (
                    // The dialog closes itself on success; keep the outcome on screen.
                    prev.kind === 'done' || prev.kind === 'error' ? prev : { kind: 'idle' }
                ))}
                title={t('settings.sessions.pruneEmpty')}
                description={t('settings.sessions.pruneEmpty.confirm', {
                    n: pruneState.kind === 'confirm' || pruneState.kind === 'deleting' ? pruneState.found : 0
                })}
                confirmLabel={t('button.delete')}
                confirmingLabel={t('misc.loading')}
                onConfirm={deleteEmptySessions}
                isPending={pruneState.kind === 'deleting'}
                destructive
            />

            <ConfirmDialog
                isOpen={closeStaleState.kind === 'confirm'}
                onClose={() => setCloseStaleState((prev) => (prev.kind === 'confirm' ? { kind: 'idle' } : prev))}
                title={t('settings.sessions.closeStale')}
                description={t('settings.sessions.closeStale.confirm', {
                    n: closeStaleState.kind === 'confirm' ? closeStaleState.ids.length : 0
                })}
                confirmLabel={t('settings.sessions.closeStale.confirmButton')}
                confirmingLabel={t('misc.loading')}
                onConfirm={async () => {
                    // Kick off the loop and let the dialog close; progress renders inline.
                    if (closeStaleState.kind === 'confirm') {
                        void closeStaleSessions(closeStaleState.ids)
                    }
                }}
                isPending={false}
                destructive
            />

            <SettingsSection title={t('settings.sessions.pruneEmpty.title')} description={t('settings.sessions.pruneEmpty.description')}>
                <div className="px-3 pb-3">
                    <button
                        type="button"
                        onClick={() => void countEmptySessions()}
                        disabled={pruneState.kind === 'checking' || pruneState.kind === 'deleting'}
                        className={actionButtonClass}
                    >
                        {pruneState.kind === 'checking' || pruneState.kind === 'deleting'
                            ? t('misc.loading')
                            : t('settings.sessions.pruneEmpty')}
                    </button>
                    {pruneState.kind === 'done' && (
                        <p className="mt-2 text-xs text-[var(--app-hint)]">
                            {pruneState.deleted === 0 && pruneState.failed === 0
                                ? t('settings.sessions.pruneEmpty.none')
                                : t('settings.sessions.pruneEmpty.done', { n: pruneState.deleted })}
                            {pruneState.failed > 0
                                ? ` ${t('settings.sessions.pruneEmpty.failed', { n: pruneState.failed })}`
                                : ''}
                        </p>
                    )}
                    {pruneState.kind === 'error' && (
                        <p className="mt-2 text-xs text-red-500">{pruneState.message}</p>
                    )}
                </div>
            </SettingsSection>

            <SettingsSection title={t('settings.sessions.closeStale.title')} description={t('settings.sessions.closeStale.description')}>
                <div className="px-3 pb-3">
                    {closeStaleState.kind === 'running' ? (
                        <div>
                            <div className="mb-1 flex items-center justify-between text-xs text-[var(--app-hint)]">
                                <span>
                                    {t('settings.sessions.closeStale.progress', {
                                        done: closeStaleState.processed,
                                        total: closeStaleState.total
                                    })}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => { stopCloseStaleRef.current = true }}
                                    className="rounded px-2 py-0.5 font-medium text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                                >
                                    {t('settings.sessions.closeStale.stop')}
                                </button>
                            </div>
                            <div
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={closeStaleState.total}
                                aria-valuenow={closeStaleState.processed}
                                className="h-2 w-full overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"
                            >
                                <div
                                    className="h-full rounded-full bg-red-500 transition-[width] duration-200"
                                    style={{ width: `${(closeStaleState.processed / closeStaleState.total) * 100}%` }}
                                />
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void findStaleSessions()}
                            disabled={closeStaleState.kind === 'checking'}
                            className={actionButtonClass}
                        >
                            {closeStaleState.kind === 'checking'
                                ? t('misc.loading')
                                : t('settings.sessions.closeStale')}
                        </button>
                    )}
                    {closeStaleState.kind === 'done' && (
                        <p className="mt-2 text-xs text-[var(--app-hint)]">
                            {closeStaleState.total === 0
                                ? t('settings.sessions.closeStale.none')
                                : t('settings.sessions.closeStale.done', { n: closeStaleState.closed })}
                            {closeStaleState.failed > 0
                                ? ` ${t('settings.sessions.closeStale.failed', { n: closeStaleState.failed })}`
                                : ''}
                            {closeStaleState.stopped
                                ? ` ${t('settings.sessions.closeStale.stopped')}`
                                : ''}
                        </p>
                    )}
                    {closeStaleState.kind === 'error' && (
                        <p className="mt-2 text-xs text-red-500">{closeStaleState.message}</p>
                    )}
                </div>
            </SettingsSection>
        </SettingsScreen>
    )
}
