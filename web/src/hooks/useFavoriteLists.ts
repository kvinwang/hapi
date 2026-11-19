import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { FavoriteList, SessionsResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionsResponse } from '@/lib/session-cache'
import { randomId } from '@/lib/randomId'

/** Custom favorite lists, stored with the account preferences so every device sees them. */
export function useFavoriteLists(api: ApiClient | null) {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.preferences,
        queryFn: () => api!.getPreferences(),
        enabled: Boolean(api)
    })
    const lists = query.data?.favoriteLists ?? []

    const { mutateAsync: saveLists } = useMutation({
        mutationFn: (favoriteLists: FavoriteList[]) => api!.updatePreferences({ favoriteLists }),
        onSuccess: (preferences) => queryClient.setQueryData(queryKeys.preferences, preferences)
    })

    const { mutateAsync: saveSessionLists } = useMutation({
        mutationFn: (input: { sessionId: string; lists: string[] }) => api!.updateSessionUiState(input.sessionId, { lists: input.lists }),
        // Applied up front so quick successive toggles build on each other instead of on stale props.
        onMutate: (input) => queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current =>
            mergeSessionsResponse(current, input.sessionId, { uiState: { lists: input.lists } })
        ),
        onSuccess: (state, input) => {
            queryClient.setQueryData(queryKeys.sessionUiState(input.sessionId), state)
            queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, current =>
                mergeSessionsResponse(current, input.sessionId, { uiState: state })
            )
        }
    })

    return {
        lists,
        create: (name: string) => saveLists([...lists, { id: randomId(), name }]),
        rename: (id: string, name: string) => saveLists(lists.map(list => list.id === id ? { ...list, name } : list)),
        remove: (id: string) => saveLists(lists.filter(list => list.id !== id)),
        setSessionLists: (sessionId: string, listIds: string[]) => saveSessionLists({ sessionId, lists: listIds })
    }
}
