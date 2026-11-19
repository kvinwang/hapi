import type { SessionSummary } from '@/types/api'

/** `all`, `favorites` (the starred sessions), or the id of a favorite list. */
export type SessionListFilter = string

export function filterSessionList(options: {
    sessions: SessionSummary[]
    archivedFilteredSessions: SessionSummary[]
    tagSearch: string
    listFilter: SessionListFilter
}): SessionSummary[] {
    const query = options.tagSearch.trim().toLocaleLowerCase()
    const { listFilter } = options
    // Favorites and tag searches include inactive sessions, regardless of the archive toggle.
    // Lists keep it: every new session joins the default list, so closed ones would pile up there.
    const source = listFilter === 'favorites' || query ? options.sessions : options.archivedFilteredSessions
    return source.filter(session => (
        (listFilter === 'all'
            || (listFilter === 'favorites' ? session.favorite === true : session.lists?.includes(listFilter) === true))
        && (!query || session.tags?.some(tag => tag.toLocaleLowerCase().includes(query)))
    ))
}
