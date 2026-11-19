import { DEFAULT_FAVORITE_LIST_ID } from '@hapi/protocol'
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StarIcon } from '@/components/icons'
import type { ApiClient } from '@/api/client'
import { useSessionFavorite } from '@/hooks/mutations/useSessionFavorite'
import { useFavoriteLists } from '@/hooks/useFavoriteLists'
import { useTranslation } from '@/lib/use-translation'

export function FavoriteListsDialog(props: {
    isOpen: boolean
    onClose: () => void
    api: ApiClient | null
    sessionId: string
    favorite: boolean
    lists: string[]
}) {
    const { t } = useTranslation()
    const [error, setError] = useState<string | null>(null)
    const run = (action: () => Promise<unknown>) => {
        setError(null)
        action().catch((err: unknown) => setError(err instanceof Error ? err.message : t('dialog.properties.error')))
    }
    const favoriteMutation = useSessionFavorite(props.api, props.sessionId)
    const favoriteLists = useFavoriteLists(props.api)
    const options = [{ id: DEFAULT_FAVORITE_LIST_ID, name: t('sessions.list.default') }, ...favoriteLists.lists]
    const toggleList = (id: string) => run(() => favoriteLists.setSessionLists(
        props.sessionId,
        props.lists.includes(id) ? props.lists.filter(list => list !== id) : [...props.lists, id]
    ))
    const rowClass = 'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] disabled:opacity-50'

    return (
        <Dialog open={props.isOpen} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('sessions.list.title')}</DialogTitle>
                </DialogHeader>
                <div className="mt-3 flex flex-col">
                    <button type="button" role="menuitemcheckbox" aria-checked={props.favorite} disabled={favoriteMutation.isPending} className={rowClass} onClick={() => run(() => favoriteMutation.mutateAsync(!props.favorite))}>
                        <StarIcon className="h-[18px] w-[18px] text-[var(--app-hint)]" fill={props.favorite ? 'currentColor' : 'none'} />
                        <span className="flex-1">{t('sessions.list.favorites')}</span>
                    </button>
                    {options.map(list => {
                        const checked = props.lists.includes(list.id)
                        return (
                            <button key={list.id} type="button" role="menuitemcheckbox" aria-checked={checked} className={rowClass} onClick={() => toggleList(list.id)}>
                                <input type="checkbox" readOnly checked={checked} tabIndex={-1} className="pointer-events-none h-4 w-4" />
                                <span className="flex-1 break-words">{list.name}</span>
                            </button>
                        )
                    })}
                    {error ? <div className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">{error}</div> : null}
                </div>
            </DialogContent>
        </Dialog>
    )
}
