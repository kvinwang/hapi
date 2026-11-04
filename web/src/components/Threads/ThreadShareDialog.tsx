import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ShareLinkControls } from '@/components/Sharing/ShareLinkControls'
import { threadButton } from './types'

export function ThreadShareDialog({
    threadId,
    open,
    onOpenChange
}: {
    threadId: string
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { api, baseUrl } = useAppContext()
    const { t } = useTranslation()
    const client = useQueryClient()
    const [pending, setPending] = useState(false)
    const [error, setError] = useState('')
    const key = ['threads', threadId, 'share']
    const status = useQuery({
        queryKey: key,
        queryFn: () => api.threadRequest<{ shareToken: string | null }>(`/${threadId}/share`),
        enabled: open
    })
    const token = status.data?.shareToken
    const url = token
        ? new URL(`/shared/threads/${encodeURIComponent(token)}`, baseUrl || window.location.origin).href
        : null
    const toggle = async () => {
        if (pending) return
        setPending(true)
        setError('')
        try {
            const result = await api.threadRequest<{ shareToken: string | null }>(`/${threadId}/share`, {
                enabled: !token
            })
            client.setQueryData(key, result)
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            setPending(false)
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <div className="mb-3 flex items-center justify-between">
                    <DialogTitle>{t('thread.share.title')}</DialogTitle>
                    <button
                        className={threadButton}
                        aria-label={t('session.threads.close')}
                        onClick={() => onOpenChange(false)}
                    >
                        ✕
                    </button>
                </div>
                <DialogDescription className="mb-4">{t('thread.share.description')}</DialogDescription>
                {(error || status.error) && (
                    <p role="alert" className="mb-3 text-sm text-red-500">
                        {error || status.error?.message}
                    </p>
                )}
                <ShareLinkControls
                    shared={Boolean(token)}
                    url={url}
                    onToggle={() => void toggle()}
                    disabled={pending || status.isPending || Boolean(status.error)}
                />
            </DialogContent>
        </Dialog>
    )
}
