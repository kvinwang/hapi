import { EyeIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'
import { threadButton } from './types'

export function ThreadArchiveFilter({ hideArchived, onToggle }: { hideArchived: boolean; onToggle: () => void }) {
    const { t } = useTranslation()
    const label = t(hideArchived ? 'session.threads.showArchived' : 'session.threads.hideArchived')
    return <button type="button" className={`${threadButton} inline-flex items-center gap-2 ${hideArchived ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)]'}`} title={label} aria-label={label} aria-pressed={hideArchived} onClick={onToggle}>
        <EyeIcon className="h-4 w-4" open={!hideArchived} />{label}
    </button>
}
