import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { QuickPhraseAction } from '@/types/api'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'
import { useTranslation } from '@/lib/use-translation'

export function QuickPhraseActionIcon(props: { action: QuickPhraseAction; className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className ?? 'h-4 w-4'}
        >
            {props.action === 'send'
                ? <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>
                : <><path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1" /><path d="M7 22h1a4 4 0 0 0 4-4v-1" /><path d="M7 2h1a4 4 0 0 1 4 4v1" /></>}
        </svg>
    )
}

const ACTION_LABEL_KEYS: Record<QuickPhraseAction, string> = {
    send: 'composer.quickPhrases.send',
    insert: 'composer.quickPhrases.insert'
}

/**
 * Tapping a phrase does what the phrase is set to do; the button beside it does the other thing.
 * Phrases that send straight away carry a send icon so a tap never sends by surprise.
 */
export function QuickPhrasesPanel(props: { api: ApiClient; onPick: (text: string, action: QuickPhraseAction) => void }) {
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
                phrases.map((phrase) => {
                    const other: QuickPhraseAction = phrase.action === 'send' ? 'insert' : 'send'
                    return (
                        <div key={phrase.text} className="flex items-stretch transition-colors hover:bg-[var(--app-secondary-bg)]">
                            <button
                                type="button"
                                title={t(ACTION_LABEL_KEYS[phrase.action])}
                                className="flex min-w-0 flex-1 items-start gap-2 py-2 pl-3 text-left text-sm text-[var(--app-fg)]"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => props.onPick(phrase.text, phrase.action)}
                            >
                                {phrase.action === 'send'
                                    ? <QuickPhraseActionIcon action="send" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--app-link)]" />
                                    : null}
                                <span className="line-clamp-2 whitespace-pre-wrap break-words">{phrase.text}</span>
                            </button>
                            <button
                                type="button"
                                title={t(ACTION_LABEL_KEYS[other])}
                                aria-label={t(ACTION_LABEL_KEYS[other])}
                                className="flex w-10 shrink-0 items-center justify-center text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => props.onPick(phrase.text, other)}
                            >
                                <QuickPhraseActionIcon action={other} />
                            </button>
                        </div>
                    )
                })
            )}
        </div>
    )
}
