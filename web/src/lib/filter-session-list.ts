import type { SessionSummary } from '@/types/api'

export function filterSessionList(options: {
    sessions: SessionSummary[]
    archivedFilteredSessions: SessionSummary[]
    tagSearch: string
    favoritesOnly: boolean
}): SessionSummary[] {
    const query = options.tagSearch.trim().toLocaleLowerCase()
    // Favorites and tag searches include inactive sessions, regardless of the archive toggle.
    const source = options.favoritesOnly || query ? options.sessions : options.archivedFilteredSessions
    return source.filter(session => (
        (!options.favoritesOnly || session.favorite === true)
        && (!query || session.tags?.some(tag => tag.toLocaleLowerCase().includes(query)))
    ))
}
