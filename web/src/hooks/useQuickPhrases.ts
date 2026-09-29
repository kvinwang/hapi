import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { QuickPhrase } from '@/types/api'
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
        mutationFn: (quickPhrases: QuickPhrase[]) => api!.updatePreferences({ quickPhrases }),
        onSuccess: (preferences) => queryClient.setQueryData(queryKeys.preferences, preferences)
    })

    const phrases = query.data?.quickPhrases ?? []
    const { mutateAsync } = mutation

    const has = useCallback((text: string) => phrases.some((phrase) => phrase.text === text.trim()), [phrases])

    /** Star a sent message; it was already sent as-is, so it sends again by default. */
    const toggle = useCallback(async (text: string) => {
        const trimmed = text.trim()
        if (!trimmed) return
        await mutateAsync(has(trimmed)
            ? phrases.filter((phrase) => phrase.text !== trimmed)
            : [{ text: trimmed, action: 'send' }, ...phrases])
    }, [has, mutateAsync, phrases])

    return {
        enabled: Boolean(api),
        phrases,
        isLoading: query.isLoading,
        isSaving: mutation.isPending,
        save: mutateAsync,
        has,
        toggle
    }
}
