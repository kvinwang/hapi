import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

export function StaleCacheDialog(props: {
    description: string | null
    onClose: () => void
    /** Absent when the session cannot clear its context; plain send becomes the only action. */
    onClearAndSend?: () => void
    onSendAnyway: () => void
}) {
    const { t } = useTranslation()
    const run = (action: () => void) => () => {
        action()
        props.onClose()
    }

    return (
        <Dialog open={props.description !== null} onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.staleCache.title')}</DialogTitle>
                    <DialogDescription className="mt-2">{props.description}</DialogDescription>
                </DialogHeader>

                <div className="mt-4 flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={props.onClose}>
                        {t('button.cancel')}
                    </Button>
                    <Button type="button" autoFocus onClick={run(props.onClearAndSend ?? props.onSendAnyway)}>
                        {t(props.onClearAndSend ? 'dialog.staleCache.clearAndSend' : 'dialog.staleCache.confirm')}
                    </Button>
                </div>
                {props.onClearAndSend ? (
                    <div className="mt-2 text-right">
                        <button
                            type="button"
                            className="text-xs text-[var(--app-hint)] underline-offset-2 hover:underline"
                            onClick={run(props.onSendAnyway)}
                        >
                            {t('dialog.staleCache.sendWithoutClearing')}
                        </button>
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}
