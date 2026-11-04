import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { StarIcon } from '@/components/icons'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'
import { useTranslation } from '@/lib/use-translation'

/** Shared message action: save text to the account's quick replies. */
export function QuickPhraseButton({
    api,
    text,
    revealOnHover = false
}: {
    api: ApiClient | null
    text: string
    revealOnHover?: boolean
}) {
    const phrases = useQuickPhrases(api)
    const { t } = useTranslation()
    const [failed, setFailed] = useState(false)
    if (!phrases.enabled || !text.trim()) return null
    const saved = phrases.has(text)
    const label = t(saved ? 'chat.quickPhrase.remove' : 'chat.quickPhrase.add')
    return (
        <>
            <button
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={saved}
                disabled={phrases.isLoading || phrases.isSaving}
                className={`${revealOnHover && !saved ? 'opacity-60 sm:opacity-0 sm:group-hover/msg:opacity-100' : 'opacity-100'} rounded p-0.5 transition-[opacity,background-color] hover:bg-[var(--app-subtle-bg)]`}
                onClick={() => {
                    setFailed(false)
                    void phrases.toggle(text).catch(() => setFailed(true))
                }}
            >
                <StarIcon
                    className={`h-3.5 w-3.5 ${saved ? 'text-amber-500' : 'text-[var(--app-hint)]'}`}
                    fill={saved ? 'currentColor' : 'none'}
                />
            </button>
            {failed && (
                <span role="alert" className="text-xs text-red-500">
                    {t('settings.quickPhrases.saveFailed')}
                </span>
            )}
        </>
    )
}
