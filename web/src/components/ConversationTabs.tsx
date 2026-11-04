import { useAppContext } from '@/lib/app-context'
import { useConversationHistory } from '@/hooks/useConversationHistory'
import { Link } from '@tanstack/react-router'

/** Route tabs shared by the session sidebar and the thread list. */
export function ConversationTabs({ active }: { active: 'sessions' | 'threads' }) {
    const { baseUrl } = useAppContext()
    const { history } = useConversationHistory(baseUrl)
    return (
        <nav aria-label="Conversations" className="inline-flex shrink-0 rounded-lg bg-[var(--app-subtle-bg)] p-0.5">
            {(['sessions', 'threads'] as const).map(tab => (
                <Link
                    key={tab}
                    {...(tab === 'sessions'
                        ? history.sessions
                            ? { to: '/sessions/$sessionId' as const, params: { sessionId: history.sessions.id } }
                            : { to: '/sessions' as const }
                        : history.threads
                          ? {
                                to: '/threads/$threadId' as const,
                                params: { threadId: history.threads.id },
                                search: { fromSession: history.threads.fromSession }
                            }
                          : { to: '/threads' as const })}
                    aria-current={active === tab ? 'page' : undefined}
                    className={`rounded-md px-2.5 py-1 text-center text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${active === tab ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                >
                    {tab === 'sessions' ? 'Sessions' : 'Threads'}
                </Link>
            ))}
        </nav>
    )
}
