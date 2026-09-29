import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

/** Saved message snippets, stored with the account preferences so every device sees the same list. */
export function useQuickPhrases(api: ApiClient | null) {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.preferences,
        queryFn: () => api!.getPreferences(),
        enabled: Boolean(api)
    })
    const mutation = useMutation({
        mutationFn: (quickPhrases: string[]) => api!.updatePreferences({ quickPhrases }),
        onSuccess: (preferences) => queryClient.setQueryData(queryKeys.preferences, preferences)
    })

    const phrases = query.data?.quickPhrases ?? []
    const { mutateAsync } = mutation

    const toggle = useCallback(async (text: string) => {
        const phrase = text.trim()
        if (!phrase) return
        await mutateAsync(phrases.includes(phrase)
            ? phrases.filter((entry) => entry !== phrase)
            : [phrase, ...phrases])
    }, [mutateAsync, phrases])

    return {
        enabled: Boolean(api),
        phrases,
        isLoading: query.isLoading,
        isSaving: mutation.isPending,
        save: mutateAsync,
        toggle
    }
}
