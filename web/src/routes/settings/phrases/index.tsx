import { useState, type ReactNode } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'
import { SettingsScreen, headerIconButtonClass } from '@/routes/settings/header'

function Icon(props: { children: ReactNode; size?: number }) {
    const size = props.size ?? 16
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {props.children}
        </svg>
    )
}

const inputClass = 'w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none'
const iconButtonClass = 'flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-30 disabled:hover:bg-transparent'

function PhraseEditor(props: { initial: string; saving: boolean; onSave: (text: string) => void; onCancel: () => void }) {
    const { t } = useTranslation()
    const [text, setText] = useState(props.initial)
    return (
        <div className="flex flex-col gap-2">
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') props.onCancel() }}
                placeholder={t('settings.quickPhrases.placeholder')}
                rows={3}
                className={inputClass}
                autoFocus
            />
            <div className="flex justify-end gap-2">
                <button type="button" onClick={props.onCancel}
                    className="rounded-lg px-3 py-1.5 text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
                    {t('button.cancel')}
                </button>
                <button type="button" onClick={() => props.onSave(text.trim())}
                    disabled={!text.trim() || props.saving}
                    className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50">
                    {t('button.save')}
                </button>
            </div>
        </div>
    )
}

export default function QuickPhrasesPage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const { phrases, isLoading, isSaving, save } = useQuickPhrases(api)
    const [adding, setAdding] = useState(false)
    const [editingIndex, setEditingIndex] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)

    const commit = async (next: string[]) => {
        setError(null)
        try {
            await save(next)
            return true
        } catch (e) {
            setError(e instanceof Error ? e.message : t('settings.quickPhrases.saveFailed'))
            return false
        }
    }

    const move = (index: number, delta: number) => {
        const next = [...phrases]
        const [entry] = next.splice(index, 1)
        next.splice(index + delta, 0, entry)
        void commit(next)
    }

    return (
        <SettingsScreen
            title={t('settings.nav.quickPhrases')}
            action={(
                <button type="button" onClick={() => setAdding(!adding)} className={headerIconButtonClass} title={t('settings.quickPhrases.add')}>
                    <Icon size={18}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Icon>
                </button>
            )}
        >
            {error && (
                <div className="mx-3 mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</div>
            )}

            {adding && (
                <div className="border-b border-[var(--app-divider)] p-3">
                    <PhraseEditor
                        initial=""
                        saving={isSaving}
                        onCancel={() => setAdding(false)}
                        onSave={async (text) => {
                            if (await commit([text, ...phrases.filter((entry) => entry !== text)])) setAdding(false)
                        }}
                    />
                </div>
            )}

            {isLoading ? (
                <div className="p-6 text-center text-[var(--app-hint)]">{t('misc.loading')}</div>
            ) : phrases.length === 0 ? (
                <div className="p-6 text-center text-sm text-[var(--app-hint)]">{t('settings.quickPhrases.empty')}</div>
            ) : (
                phrases.map((phrase, index) => (
                    <div key={phrase} className="border-b border-[var(--app-divider)] px-3 py-3">
                        {editingIndex === index ? (
                            <PhraseEditor
                                initial={phrase}
                                saving={isSaving}
                                onCancel={() => setEditingIndex(null)}
                                onSave={async (text) => {
                                    const next = phrases.map((entry, i) => (i === index ? text : entry))
                                    if (await commit(next)) setEditingIndex(null)
                                }}
                            />
                        ) : (
                            <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-[var(--app-fg)] line-clamp-4">
                                    {phrase}
                                </div>
                                <div className="flex shrink-0 items-center">
                                    <button type="button" className={iconButtonClass} disabled={index === 0 || isSaving}
                                        onClick={() => move(index, -1)} title={t('settings.quickPhrases.moveUp')}>
                                        <Icon><polyline points="18 15 12 9 6 15" /></Icon>
                                    </button>
                                    <button type="button" className={iconButtonClass} disabled={index === phrases.length - 1 || isSaving}
                                        onClick={() => move(index, 1)} title={t('settings.quickPhrases.moveDown')}>
                                        <Icon><polyline points="6 9 12 15 18 9" /></Icon>
                                    </button>
                                    <button type="button" className={iconButtonClass}
                                        onClick={() => setEditingIndex(index)} title={t('settings.action.edit')}>
                                        <Icon>
                                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                        </Icon>
                                    </button>
                                    <button type="button" disabled={isSaving}
                                        className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:bg-red-500/10 hover:text-red-500"
                                        onClick={() => void commit(phrases.filter((_, i) => i !== index))} title={t('button.delete')}>
                                        <Icon>
                                            <polyline points="3 6 5 6 21 6" />
                                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                        </Icon>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ))
            )}
        </SettingsScreen>
    )
}
