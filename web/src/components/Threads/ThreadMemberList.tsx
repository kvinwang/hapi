import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'
import { ThreadAvatar } from './ThreadAvatar'
import { memberName, threadButton, type Member } from './types'

/** A read-only member list, for guests who cannot manage the thread. */
export function ThreadMemberList({ members, open, onOpenChange }: { members: Member[]; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useTranslation()
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <div className="flex items-center justify-between">
                    <DialogTitle>{t('thread.members.title')}</DialogTitle>
                    <button className={threadButton} aria-label={t('session.threads.close')} onClick={() => onOpenChange(false)}>✕</button>
                </div>
                <DialogDescription className="sr-only">{t('thread.members.count', { count: members.length })}</DialogDescription>
                <ul className="mt-3 space-y-3">
                    {members.map(member => (
                        <li key={member.id} className="flex items-center gap-2">
                            {member.kind === 'user' ? <span className="w-7 shrink-0" /> : <ThreadAvatar id={member.id} kind={member.kind} />}
                            <span className="min-w-0 flex-1 truncate font-medium">{memberName(member)}</span>
                            <span className="text-xs text-[var(--app-hint)]">{member.status}</span>
                        </li>
                    ))}
                </ul>
            </DialogContent>
        </Dialog>
    )
}
