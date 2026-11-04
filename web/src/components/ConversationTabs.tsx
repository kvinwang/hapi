import { Link } from '@tanstack/react-router'

/** Route tabs shared by the session sidebar and the thread list. */
export function ConversationTabs({ active }: { active: 'sessions' | 'threads' }) {
    return (
        <nav aria-label="Conversations" className="inline-flex shrink-0 rounded-lg bg-[var(--app-subtle-bg)] p-0.5">
            {(['sessions', 'threads'] as const).map(tab => (
                <Link
                    key={tab}
                    to={tab === 'sessions' ? '/sessions' : '/threads'}
                    aria-current={active === tab ? 'page' : undefined}
                    className={`rounded-md px-2.5 py-1 text-center text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${active === tab ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                >
                    {tab === 'sessions' ? 'Sessions' : 'Threads'}
                </Link>
            ))}
        </nav>
    )
}
