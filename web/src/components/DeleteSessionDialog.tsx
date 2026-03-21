import { useEffect, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

type DeleteSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionName: string
    directChildCount: number
    descendantCount: number
    isPending: boolean
    onDeleteSingle: () => Promise<void>
    onDeleteRecursive: () => Promise<void>
}

export function DeleteSessionDialog(props: DeleteSessionDialogProps) {
    const { t } = useTranslation()
    const {
        isOpen,
        onClose,
        sessionName,
        directChildCount,
        descendantCount,
        isPending,
        onDeleteSingle,
        onDeleteRecursive
    } = props
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (isOpen) {
            setError(null)
        }
    }, [isOpen])

    const hasChildren = directChildCount > 0

    const handleAction = async (fn: () => Promise<void>) => {
        setError(null)
        try {
            await fn()
            onClose()
        } catch (err) {
            setError(err instanceof Error && err.message ? err.message : t('dialog.error.default'))
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.delete.title')}</DialogTitle>
                    <DialogDescription className="mt-2">
                        {hasChildren
                            ? t('dialog.delete.descriptionWithChildren', {
                                name: sessionName,
                                children: directChildCount,
                                descendants: descendantCount
                            })
                            : t('dialog.delete.description', { name: sessionName })}
                    </DialogDescription>
                </DialogHeader>

                {error ? (
                    <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        {t('button.cancel')}
                    </Button>
                    {hasChildren ? (
                        <>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => void handleAction(onDeleteSingle)}
                                disabled={isPending}
                            >
                                {isPending ? t('dialog.delete.confirming') : t('dialog.delete.keepChildren')}
                            </Button>
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => void handleAction(onDeleteRecursive)}
                                disabled={isPending}
                            >
                                {isPending ? t('dialog.delete.confirming') : t('dialog.delete.deleteRecursive')}
                            </Button>
                        </>
                    ) : (
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={() => void handleAction(onDeleteSingle)}
                            disabled={isPending}
                        >
                            {isPending ? t('dialog.delete.confirming') : t('dialog.delete.confirm')}
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
