import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName, type Language } from '@/lib/languages'
import { getFontScaleOptions, useFontScale, type FontScale } from '@/hooks/useFontScale'
import { isRainbowEnabled, setRainbowEnabled } from '@/components/LazyRainbowText'
import { PROTOCOL_VERSION } from '@hapi/protocol'

const locales: { value: Locale; nativeLabel: string }[] = [
    { value: 'en', nativeLabel: 'English' },
    { value: 'zh-CN', nativeLabel: '简体中文' },
]

const voiceLanguages = getElevenLabsSupportedLanguages()

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

function CopyIcon(props: { className?: string }) {
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
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

function ChevronRightIcon(props: { className?: string }) {
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
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

export default function SettingsPage() {
    const { t, locale, setLocale } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { api, logout } = useAppContext()
    const [isOpen, setIsOpen] = useState(false)
    const [isFontOpen, setIsFontOpen] = useState(false)
    const [isVoiceOpen, setIsVoiceOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const fontContainerRef = useRef<HTMLDivElement>(null)
    const voiceContainerRef = useRef<HTMLDivElement>(null)
    const { fontScale, setFontScale } = useFontScale()
    const [rainbowOn, setRainbowOn] = useState(() => isRainbowEnabled())
    const [installCopied, setInstallCopied] = useState<'unix' | 'win' | null>(null)
    const [inviteData, setInviteData] = useState<{ token: string; expiresAt: number } | null>(null)
    const [creatingInvite, setCreatingInvite] = useState(false)

    // Voice language state - read from localStorage
    const [voiceLanguage, setVoiceLanguage] = useState<string | null>(() => {
        return localStorage.getItem('hapi-voice-lang')
    })

    // Global system prompt
    const { data: preferences } = useQuery({
        queryKey: queryKeys.preferences,
        queryFn: () => api.getPreferences()
    })
    const [globalPrompt, setGlobalPrompt] = useState('')
    const [globalPromptInitialized, setGlobalPromptInitialized] = useState(false)
    const [savingPrompt, setSavingPrompt] = useState(false)
    const [promptSaved, setPromptSaved] = useState(false)

    useEffect(() => {
        if (preferences && !globalPromptInitialized) {
            setGlobalPrompt(preferences.systemPrompt)
            setGlobalPromptInitialized(true)
        }
    }, [preferences, globalPromptInitialized])

    const globalPromptChanged = globalPromptInitialized && globalPrompt !== (preferences?.systemPrompt ?? '')

    const handleSaveGlobalPrompt = useCallback(async () => {
        setSavingPrompt(true)
        setPromptSaved(false)
        try {
            const result = await api.updatePreferences({ systemPrompt: globalPrompt })
            setGlobalPrompt(result.systemPrompt)
            setPromptSaved(true)
            setTimeout(() => setPromptSaved(false), 2000)
        } finally {
            setSavingPrompt(false)
        }
    }, [api, globalPrompt])

    const fontScaleOptions = getFontScaleOptions()
    const currentLocale = locales.find((loc) => loc.value === locale)
    const currentFontScaleLabel = fontScaleOptions.find((opt) => opt.value === fontScale)?.label ?? '100%'
    const currentVoiceLanguage = voiceLanguages.find((lang) => lang.code === voiceLanguage)

    const handleLocaleChange = (newLocale: Locale) => {
        setLocale(newLocale)
        setIsOpen(false)
    }

    const handleFontScaleChange = (newScale: FontScale) => {
        setFontScale(newScale)
        setIsFontOpen(false)
    }

    const handleVoiceLanguageChange = (language: Language) => {
        setVoiceLanguage(language.code)
        if (language.code === null) {
            localStorage.removeItem('hapi-voice-lang')
        } else {
            localStorage.setItem('hapi-voice-lang', language.code)
        }
        setIsVoiceOpen(false)
    }

    // Close dropdown when clicking outside
    useEffect(() => {
        if (!isOpen && !isFontOpen && !isVoiceOpen) return

        const handleClickOutside = (event: MouseEvent) => {
            if (isOpen && containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false)
            }
            if (isFontOpen && fontContainerRef.current && !fontContainerRef.current.contains(event.target as Node)) {
                setIsFontOpen(false)
            }
            if (isVoiceOpen && voiceContainerRef.current && !voiceContainerRef.current.contains(event.target as Node)) {
                setIsVoiceOpen(false)
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [isOpen, isFontOpen, isVoiceOpen])

    // Close on escape key
    useEffect(() => {
        if (!isOpen && !isFontOpen && !isVoiceOpen) return

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false)
                setIsFontOpen(false)
                setIsVoiceOpen(false)
            }
        }

        document.addEventListener('keydown', handleEscape)
        return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen, isFontOpen, isVoiceOpen])

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
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
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

                    {/* Display section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.display.title')}
                        </div>
                        <div ref={fontContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsFontOpen(!isFontOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isFontOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.display.fontSize')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>{currentFontScaleLabel}</span>
                                    <ChevronDownIcon className={`transition-transform ${isFontOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isFontOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[140px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg overflow-hidden z-50"
                                    role="listbox"
                                    aria-label={t('settings.display.fontSize')}
                                >
                                    {fontScaleOptions.map((opt) => {
                                        const isSelected = fontScale === opt.value
                                        return (
                                            <button
                                                key={opt.value}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleFontScaleChange(opt.value)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{opt.label}</span>
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
                        <button
                            type="button"
                            onClick={() => {
                                const next = !rainbowOn
                                setRainbowOn(next)
                                setRainbowEnabled(next)
                            }}
                            className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            <span className="text-[var(--app-fg)]">{t('settings.display.rainbowText')}</span>
                            <span className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer rounded-full transition-colors ${rainbowOn ? 'bg-[var(--app-link)]' : 'bg-[var(--app-border)]'}`}>
                                <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${rainbowOn ? 'translate-x-[18px]' : 'translate-x-[2px]'} mt-[2px]`} />
                            </span>
                        </button>
                    </div>

                    {/* Voice Assistant section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.voice.title')}
                        </div>
                        <div ref={voiceContainerRef} className="relative">
                            <button
                                type="button"
                                onClick={() => setIsVoiceOpen(!isVoiceOpen)}
                                className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                aria-expanded={isVoiceOpen}
                                aria-haspopup="listbox"
                            >
                                <span className="text-[var(--app-fg)]">{t('settings.voice.language')}</span>
                                <span className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <span>
                                        {currentVoiceLanguage
                                            ? currentVoiceLanguage.code === null
                                                ? t('settings.voice.autoDetect')
                                                : getLanguageDisplayName(currentVoiceLanguage)
                                            : t('settings.voice.autoDetect')}
                                    </span>
                                    <ChevronDownIcon className={`transition-transform ${isVoiceOpen ? 'rotate-180' : ''}`} />
                                </span>
                            </button>

                            {isVoiceOpen && (
                                <div
                                    className="absolute right-3 top-full mt-1 min-w-[200px] max-h-[300px] overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-lg z-50"
                                    role="listbox"
                                    aria-label={t('settings.voice.title')}
                                >
                                    {voiceLanguages.map((lang) => {
                                        const isSelected = voiceLanguage === lang.code
                                        const displayName = lang.code === null
                                            ? t('settings.voice.autoDetect')
                                            : getLanguageDisplayName(lang)
                                        return (
                                            <button
                                                key={lang.code ?? 'auto'}
                                                type="button"
                                                role="option"
                                                aria-selected={isSelected}
                                                onClick={() => handleVoiceLanguageChange(lang)}
                                                className={`flex items-center justify-between w-full px-3 py-2 text-base text-left transition-colors ${
                                                    isSelected
                                                        ? 'text-[var(--app-link)] bg-[var(--app-subtle-bg)]'
                                                        : 'text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                                }`}
                                            >
                                                <span>{displayName}</span>
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

                    {/* System Prompt section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.systemPrompt.title')}
                        </div>
                        <div className="px-3 pb-3">
                            <p className="text-xs text-[var(--app-hint)] mb-2">
                                {t('settings.systemPrompt.description')}
                            </p>
                            <textarea
                                value={globalPrompt}
                                onChange={(e) => setGlobalPrompt(e.target.value)}
                                placeholder={t('settings.systemPrompt.placeholder')}
                                className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none min-h-[100px] max-h-[300px] resize-y"
                                maxLength={10000}
                                rows={4}
                                disabled={savingPrompt}
                            />
                            {(globalPromptChanged || promptSaved) && (
                                <div className="mt-2 flex justify-end">
                                    {promptSaved ? (
                                        <span className="text-sm text-[var(--app-link)]">{t('settings.systemPrompt.saved')}</span>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={handleSaveGlobalPrompt}
                                            disabled={savingPrompt}
                                            className="rounded-lg px-4 py-1.5 text-sm font-medium bg-[var(--app-link)] text-white hover:opacity-90 transition-colors disabled:opacity-50"
                                        >
                                            {savingPrompt ? t('dialog.properties.saving') : t('button.save')}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Credentials & API Keys section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Security
                        </div>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/credentials' })}
                            className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            <span className="text-[var(--app-fg)]">Agent Credentials</span>
                            <ChevronRightIcon className="text-[var(--app-hint)]" />
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/keys' })}
                            className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            <span className="text-[var(--app-fg)]">API Keys</span>
                            <ChevronRightIcon className="text-[var(--app-hint)]" />
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/machines' })}
                            className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            <span className="text-[var(--app-fg)]">Machines</span>
                            <ChevronRightIcon className="text-[var(--app-hint)]" />
                        </button>
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/speakers' })}
                            className="flex w-full items-center justify-between px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                        >
                            <span className="text-[var(--app-fg)]">Speakers</span>
                            <ChevronRightIcon className="text-[var(--app-hint)]" />
                        </button>
                    </div>

                    {/* Install section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Install
                        </div>
                        <div className="px-3 pb-3">
                            <p className="text-xs text-[var(--app-hint)] mb-2">
                                {inviteData ? 'Send this command to the remote user:' : 'Run on a remote machine to install a runner:'}
                            </p>
                            {/* Unix */}
                            <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2">
                                <span className="shrink-0 text-[10px] text-[var(--app-hint)] font-mono uppercase">Unix</span>
                                <code className="flex-1 text-sm text-[var(--app-fg)] break-all select-all">
                                    {inviteData
                                        ? `curl -fsSL ${window.location.origin}/install | bash -s -- --join ${inviteData.token}`
                                        : `curl -fsSL ${window.location.origin}/install | bash`}
                                </code>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const cmd = inviteData
                                            ? `curl -fsSL ${window.location.origin}/install | bash -s -- --join ${inviteData.token}`
                                            : `curl -fsSL ${window.location.origin}/install | bash`
                                        navigator.clipboard.writeText(cmd)
                                        setInstallCopied('unix')
                                        setTimeout(() => setInstallCopied(null), 2000)
                                    }}
                                    className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                                    title="Copy"
                                >
                                    {installCopied === 'unix' ? <CheckIcon className="text-[var(--app-link)]" /> : <CopyIcon />}
                                </button>
                            </div>
                            {/* Windows */}
                            <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 mt-2">
                                <span className="shrink-0 text-[10px] text-[var(--app-hint)] font-mono uppercase">Win</span>
                                {inviteData ? (
                                    <a
                                        href={`${window.location.origin}/install?os=windows&token=${encodeURIComponent(inviteData.token)}`}
                                        className="flex-1 text-sm text-[var(--app-link)] break-all hover:underline"
                                        download="hapi-join.bat"
                                    >
                                        Download hapi-join.bat
                                    </a>
                                ) : (
                                    <>
                                        <code className="flex-1 text-sm text-[var(--app-fg)] break-all select-all">
                                            {`powershell -c "irm ${window.location.origin}/install.ps1 | iex"`}
                                        </code>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                navigator.clipboard.writeText(`powershell -c "irm ${window.location.origin}/install.ps1 | iex"`)
                                                setInstallCopied('win')
                                                setTimeout(() => setInstallCopied(null), 2000)
                                            }}
                                            className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                                            title="Copy"
                                        >
                                            {installCopied === 'win' ? <CheckIcon className="text-[var(--app-link)]" /> : <CopyIcon />}
                                        </button>
                                    </>
                                )}
                            </div>
                            {inviteData && (
                                <div className="mt-1.5 text-[10px] text-[var(--app-hint)] text-center">
                                    Expires {new Date(inviteData.expiresAt).toLocaleString()}
                                </div>
                            )}
                            {/* Quick Join button */}
                            <button
                                type="button"
                                onClick={async () => {
                                    setCreatingInvite(true)
                                    try {
                                        const result = await api.createInvite()
                                        setInviteData({ token: result.token, expiresAt: result.expiresAt })
                                    } catch { /* ignore */ }
                                    finally { setCreatingInvite(false) }
                                }}
                                disabled={creatingInvite}
                                className="mt-3 w-full rounded-lg px-4 py-2 text-sm font-medium bg-[var(--app-link)] text-white hover:opacity-90 transition-colors disabled:opacity-50"
                            >
                                {creatingInvite ? 'Creating...' : inviteData ? 'Regenerate Quick Join Token' : 'Quick Join (Temporary)'}
                            </button>
                            <p className="text-[10px] text-[var(--app-hint)] mt-1 text-center">
                                Generate a temporary token for remote assist
                            </p>
                        </div>
                    </div>

                    {/* About section */}
                    <div className="border-b border-[var(--app-divider)]">
                        <div className="px-3 py-2 text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            {t('settings.about.title')}
                        </div>
                        <div className="flex w-full items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.about.website')}</span>
                            <a
                                href="https://hapi.run"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--app-link)] hover:underline"
                            >
                                hapi.run
                            </a>
                        </div>
                        <div className="flex w-full items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.about.appVersion')}</span>
                            <span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>
                        </div>
                        <div className="flex w-full items-center justify-between px-3 py-3">
                            <span className="text-[var(--app-fg)]">{t('settings.about.protocolVersion')}</span>
                            <span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>
                        </div>
                    </div>

                    {/* Logout */}
                    {logout && (
                        <div className="py-4">
                            <button
                                type="button"
                                onClick={logout}
                                className="flex w-full items-center justify-center px-3 py-3 text-red-500 transition-colors hover:bg-[var(--app-subtle-bg)] rounded-lg"
                            >
                                Log Out
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
