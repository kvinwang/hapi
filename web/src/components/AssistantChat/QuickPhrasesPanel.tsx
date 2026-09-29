import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'
import { useTranslation } from '@/lib/use-translation'

export function QuickPhrasesPanel(props: { api: ApiClient; onSelect: (phrase: string) => void }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { phrases, isLoading } = useQuickPhrases(props.api)

    return (
        <div className="py-1">
            <div className="flex items-center justify-between px-3 pb-1 pt-1">
                <span className="text-xs font-semibold text-[var(--app-hint)]">{t('settings.nav.quickPhrases')}</span>
                <button
                    type="button"
                    className="text-xs text-[var(--app-link)] hover:underline"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => navigate({ to: '/settings/chat/phrases' })}
                >
                    {t('composer.quickPhrases.manage')}
                </button>
            </div>
            {isLoading ? (
                <div className="px-3 py-2 text-sm text-[var(--app-hint)]">{t('misc.loading')}</div>
            ) : phrases.length === 0 ? (
                <div className="px-3 py-2 text-sm text-[var(--app-hint)]">{t('composer.quickPhrases.empty')}</div>
            ) : (
                phrases.map((phrase) => (
                    <button
                        key={phrase}
                        type="button"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => props.onSelect(phrase)}
                    >
                        <span className="line-clamp-2 whitespace-pre-wrap break-words">{phrase}</span>
                    </button>
                ))
            )}
        </div>
    )
}
