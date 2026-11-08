import { OPEN_VOICE_PANEL } from '@/hooks/useVoicePanelSettings'
import { useTranslation } from '@/lib/use-translation'

export function VoiceDraftButton() {
    const { t } = useTranslation()
    return (
        <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_VOICE_PANEL))}
            aria-label={t('voice.ui.openDraft')} title={t('voice.ui.openDraft')}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" />
            </svg>
        </button>
    )
}
