import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { SharedSessionSummary } from '@/types/api'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function formatRelativeTime(value: number, t: (key: string, params?: Record<string, string | number>) => string): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    if (!Number.isFinite(ms)) return ''
    const delta = Date.now() - ms
    if (delta < 60_000) return t('session.time.justNow')
    const minutes = Math.floor(delta / 60_000)
    if (minutes < 60) return t('session.time.minutesAgo', { n: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('session.time.hoursAgo', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('session.time.daysAgo', { n: days })
    return new Date(ms).toLocaleDateString()
}

function LinkIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
    )
}

function UnlinkIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" />
            <path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" />
            <line x1="8" x2="8" y1="2" y2="5" />
            <line x1="2" x2="5" y1="8" y2="8" />
            <line x1="16" x2="16" y1="19" y2="22" />
            <line x1="19" x2="22" y1="16" y2="16" />
        </svg>
    )
}

function ExternalLinkIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" x2="21" y1="14" y2="3" />
        </svg>
    )
}

function BackIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

export default function SharedSessionsPage(props: { api: ApiClient | null }) {
    const { api } = props
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [sessions, setSessions] = useState<SharedSessionSummary[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [copiedId, setCopiedId] = useState<string | null>(null)

    const fetchSessions = useCallback(async () => {
        if (!api) return
        try {
            const res = await api.getSharedSessions()
            setSessions(res.sessions)
        } catch (err) {
            console.error('Failed to fetch shared sessions:', err)
        } finally {
            setIsLoading(false)
        }
    }, [api])

    useEffect(() => {
        void fetchSessions()
    }, [fetchSessions])

    const handleCopyLink = useCallback(async (sessionId: string) => {
        const shareUrl = `${window.location.origin}/shared/${sessionId}`
        try {
            await navigator.clipboard.writeText(shareUrl)
            setCopiedId(sessionId)
            setTimeout(() => setCopiedId((prev) => prev === sessionId ? null : prev), 2000)
        } catch { /* ignore */ }
    }, [])

    const handleUnshare = useCallback(async (sessionId: string) => {
        if (!api) return
        try {
            await api.unshareSession(sessionId)
            setSessions((prev) => prev.filter((s) => s.id !== sessionId))
        } catch (err) {
            console.error('Failed to unshare session:', err)
        }
    }, [api])

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)]">
            {/* Header */}
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="flex items-center gap-2 p-3">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/sessions' })}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="font-semibold">{t('shared.title')}</div>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
                {isLoading ? (
                    <div className="flex items-center justify-center p-8">
                        <Spinner label={null} />
                    </div>
                ) : sessions.length === 0 ? (
                    <div className="flex items-center justify-center p-8 text-sm text-[var(--app-hint)]">
                        {t('shared.empty')}
                    </div>
                ) : (
                    <div className="mx-auto w-full max-w-2xl px-3 py-2">
                        <div className="flex flex-col gap-1">
                            {sessions.map((session) => (
                                <div
                                    key={session.id}
                                    className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--app-subtle-bg)]"
                                >
                                    {/* Session info — click navigates to the session */}
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 text-left"
                                        onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })}
                                    >
                                        <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                                            {session.title}
                                        </div>
                                        <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                                            {session.flavor ? (
                                                <span>
                                                    <span aria-hidden="true">&#10022;</span> {session.flavor}
                                                </span>
                                            ) : null}
                                            <span>{formatRelativeTime(session.updatedAt, t)}</span>
                                        </div>
                                    </button>

                                    {/* Actions */}
                                    <div className="flex shrink-0 items-center gap-1">
                                        {/* Open shared view */}
                                        <button
                                            type="button"
                                            onClick={() => navigate({ to: '/shared/$shareToken', params: { shareToken: session.id } })}
                                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                                            title={t('shared.openSession')}
                                        >
                                            <ExternalLinkIcon />
                                        </button>

                                        {/* Copy link */}
                                        <button
                                            type="button"
                                            onClick={() => handleCopyLink(session.id)}
                                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)]"
                                            title={t('shared.copyLink')}
                                        >
                                            {copiedId === session.id ? (
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500">
                                                    <polyline points="20 6 9 17 4 12" />
                                                </svg>
                                            ) : (
                                                <LinkIcon />
                                            )}
                                        </button>

                                        {/* Unshare */}
                                        <button
                                            type="button"
                                            onClick={() => handleUnshare(session.id)}
                                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-red-500/10 hover:text-red-500"
                                            title={t('session.action.unshare')}
                                        >
                                            <UnlinkIcon />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
