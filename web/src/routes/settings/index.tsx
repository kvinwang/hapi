import { useState, useRef, useEffect } from 'react'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'

const locales: { value: Locale; nativeLabel: string }[] = [
    { value: 'en', nativeLabel: 'English' },
    { value: 'zh-CN', nativeLabel: '简体中文' },
]

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

export default function SettingsPage() {
    const { t, locale, setLocale } = useTranslation()
    const goBack = useAppGoBack()
    const [isOpen, setIsOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    const currentLocale = locales.find((loc) => loc.value === locale)

    const handleLocaleChange = (newLocale: Locale) => {
        setLocale(newLocale)
        setIsOpen(false)
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!isOpen) return

        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen])

    // Close on escape key
    useEffect(() => {
        if (!isOpen) return

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
            }
        }

        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="flex-1 font-semibold">{t('settings.title')}</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {/* Language section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.language.title')}
                        </div>
                        <div ref={containerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsOpen(!isOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.language.label')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{currentLocale?.nativeLabel}</span>
                                    <ChevronDownIcon className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[160px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.language.title')}
                                >
                                    {locales.map((loc) => {
                                        const isSelected = locale === loc.value
                                        return (
                                            <button
                                                key={loc.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleLocaleChange(loc.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-sm text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{loc.nativeLabel}</span>
                                                {isSelected && (
                                                    <span className="ml-2 text-[var(--app-link)]">
                                                        <CheckIcon />
                                                    </span>
                                                )}
                                            </button>
                                        )
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
