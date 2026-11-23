import type { SessionSummary } from '@/types/api'

/** `all`, `favorites` (the starred sessions), `unread`, or the id of a favorite list. */
export type SessionListFilter = string

export function isSessionUnread(session: SessionSummary): boolean {
    return session.readSeq !== undefined && (session.latestSeq ?? 0) > session.readSeq
}

function matchesList(session: SessionSummary, listFilter: SessionListFilter): boolean {
    if (listFilter === 'all') return true
    if (listFilter === 'favorites') return session.favorite === true
    if (listFilter === 'unread') return isSessionUnread(session)
    return session.lists?.includes(listFilter) === true
}

export function filterSessionList(options: {
    sessions: SessionSummary[]
    archivedFilteredSessions: SessionSummary[]
    tagSearch: string
    listFilter: SessionListFilter
}): SessionSummary[] {
    const query = options.tagSearch.trim().toLocaleLowerCase()
    const { listFilter } = options
    // Favorites, unread and tag searches include inactive sessions, regardless of the archive toggle.
    // Lists keep it: every new session joins the default list, so closed ones would pile up there.
    const source = listFilter === 'favorites' || listFilter === 'unread' || query ? options.sessions : options.archivedFilteredSessions
    return source.filter(session => (
        matchesList(session, listFilter)
        && (!query || session.tags?.some(tag => tag.toLocaleLowerCase().includes(query)))
    ))
}
