import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName } from '@/lib/languages'
import { getFontScaleOptions, useFontScale } from '@/hooks/useFontScale'
import { isRainbowEnabled, setRainbowEnabled } from '@/components/LazyRainbowText'
import { isPerformanceMonitorEnabled, setPerformanceMonitorEnabled } from '@/components/PerformanceMonitor'
import { getTerminalFontSizeOptions, useTerminalFontSize } from '@/hooks/useTerminalFontSize'
import { useAppearance, getAppearanceOptions } from '@/hooks/useTheme'
import { getChatPageSizeOptions, useChatPageSize } from '@/hooks/useChatPageSize'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { ModelPricing } from '@/types/api'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import {
    SettingsIndexBar,
    SettingsInfoRow,
    SettingsLinkRow,
    SettingsSection,
    SettingsSelectRow,
    SettingsToggleRow
} from '@/routes/settings/controls'

const locales: { value: Locale; nativeLabel: string }[] = [
    { value: 'en', nativeLabel: 'English' },
    { value: 'zh-CN', nativeLabel: '简体中文' },
]

const voiceLanguages = getElevenLabsSupportedLanguages()

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function CopyIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={props.className}
        >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    )
}

function DownloadIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    )
}

/** One copyable install command. */
function InstallCommandRow(props: {
    platform: string
    command: string
    copied: boolean
    onCopy: () => void
    action?: 'copy' | 'open'
    onOpen?: () => void
}) {
    return (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 first:mt-0">
            <span className="shrink-0 font-mono text-[10px] uppercase text-[var(--app-hint)]">{props.platform}</span>
            <code className="flex-1 select-all break-all text-sm text-[var(--app-fg)]">{props.command}</code>
            <button
                type="button"
                onClick={props.action === 'open' ? props.onOpen : props.onCopy}
                className="shrink-0 rounded p-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                title={props.action === 'open' ? 'Download' : 'Copy'}
            >
                {props.action === 'open'
                    ? <DownloadIcon />
                    : props.copied ? <CheckIcon className="text-[var(--app-link)]" /> : <CopyIcon />}
            </button>
        </div>
    )
}

export default function SettingsPage() {
    const { t, locale, setLocale } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { api, logout } = useAppContext()
    const { fontScale, setFontScale } = useFontScale()
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { appearance, setAppearance } = useAppearance()
    const { chatPageSize, setChatPageSize } = useChatPageSize()
    const [rainbowOn, setRainbowOn] = useState(() => isRainbowEnabled())
    const [performanceMonitorOn, setPerformanceMonitorOn] = useState(() => isPerformanceMonitorEnabled())
    const queryClient = useQueryClient()
    const [pruneState, setPruneState] = useState<
        { kind: 'idle' }
        | { kind: 'checking' }
        | { kind: 'confirm'; found: number }
        | { kind: 'deleting'; found: number }
        | { kind: 'done'; deleted: number; failed: number }
        | { kind: 'error'; message: string }
    >({ kind: 'idle' })
    const [installCopied, setInstallCopied] = useState<'unix' | 'win' | null>(null)
    const [inviteData, setInviteData] = useState<{ token: string; expiresAt: number } | null>(null)
    const [creatingInvite, setCreatingInvite] = useState(false)
    const [guestName, setGuestName] = useState('')

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
    const { data: pricingData, refetch: refetchPricing } = useQuery({
        queryKey: ['model-pricing'],
        queryFn: () => api.listModelPricing()
    })
    const [pricingDraft, setPricingDraft] = useState({ model: '', input: '', output: '', cached: '' })
    const [savingPricing, setSavingPricing] = useState(false)

    const savePricing = useCallback(async () => {
        const inputPerMillion = Number(pricingDraft.input)
        const outputPerMillion = Number(pricingDraft.output)
        const cachedInputPerMillion = Number(pricingDraft.cached)
        if (!pricingDraft.model.trim() || ![inputPerMillion, outputPerMillion, cachedInputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) return
        setSavingPricing(true)
        try {
            await api.setModelPricing(pricingDraft.model.trim(), { inputPerMillion, outputPerMillion, cachedInputPerMillion })
            setPricingDraft({ model: '', input: '', output: '', cached: '' })
            await refetchPricing()
        } finally {
            setSavingPricing(false)
        }
    }, [api, pricingDraft, refetchPricing])

    const deletePricing = useCallback(async (pricing: ModelPricing) => {
        await api.deleteModelPricing(pricing.model)
        await refetchPricing()
    }, [api, refetchPricing])

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

    const appearanceOptions = getAppearanceOptions().map((option) => ({
        value: option.value,
        label: t(option.labelKey)
    }))
    const voiceLanguageOptions = voiceLanguages.map((language) => ({
        value: language.code,
        label: language.code === null ? t('settings.voice.autoDetect') : getLanguageDisplayName(language)
    }))

    const currentLocaleLabel = locales.find((entry) => entry.value === locale)?.nativeLabel ?? 'English'
    const currentAppearanceLabel = appearanceOptions.find((option) => option.value === appearance)?.label
        ?? t('settings.display.appearance.system')
    const currentFontScaleLabel = getFontScaleOptions().find((option) => option.value === fontScale)?.label ?? '100%'
    const currentTerminalFontSizeLabel = getTerminalFontSizeOptions()
        .find((option) => option.value === terminalFontSize)?.label ?? '13px'
    const currentVoiceLanguageLabel = voiceLanguageOptions.find((option) => option.value === voiceLanguage)?.label
        ?? t('settings.voice.autoDetect')

    const handleVoiceLanguageChange = (code: string | null) => {
        setVoiceLanguage(code)
        if (code === null) {
            localStorage.removeItem('hapi-voice-lang')
        } else {
            localStorage.setItem('hapi-voice-lang', code)
        }
    }

    // Count first, ask, then delete: a cleanup nobody can preview is a cleanup
    // nobody dares run.
    const countEmptySessions = useCallback(async () => {
        setPruneState({ kind: 'checking' })
        try {
            const result = await api.pruneEmptySessions(true)
            setPruneState(result.found === 0
                ? { kind: 'done', deleted: 0, failed: 0 }
                : { kind: 'confirm', found: result.found })
        } catch (error) {
            setPruneState({ kind: 'error', message: error instanceof Error ? error.message : 'Failed' })
        }
    }, [api])

    const deleteEmptySessions = useCallback(async () => {
        setPruneState((prev) => ({ kind: 'deleting', found: prev.kind === 'confirm' ? prev.found : 0 }))
        try {
            const result = await api.pruneEmptySessions(false)
            setPruneState({ kind: 'done', deleted: result.deleted, failed: result.failed })
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        } catch (error) {
            setPruneState({ kind: 'error', message: error instanceof Error ? error.message : 'Failed' })
        }
    }, [api, queryClient])

    const scrollRef = useRef<HTMLDivElement>(null)
    const sections = useMemo(() => [
        { id: 'appearance', label: t('settings.section.appearance') },
        { id: 'chat', label: t('settings.section.chat') },
        { id: 'sessions', label: t('settings.section.sessions') },
        { id: 'voice', label: t('settings.voice.title') },
        { id: 'system-prompt', label: t('settings.systemPrompt.title') },
        { id: 'model-pricing', label: t('settings.modelPricing.title') },
        { id: 'devices', label: t('settings.section.devices') },
        { id: 'add-device', label: t('settings.section.addDevice') },
        { id: 'security', label: t('settings.section.security') },
        { id: 'about', label: t('settings.about.title') }
    ], [t])

    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const unixCommand = inviteData
        ? `curl -fsSL ${origin}/install | bash -s -- --join ${inviteData.token}`
        : `curl -fsSL ${origin}/install | bash`
    const windowsCommand = inviteData
        ? `${origin}/install?os=windows&quick=1&token=${inviteData.token}${guestName.trim() ? `&display=${encodeURIComponent(guestName.trim())}` : ''}`
        : `${origin}/install?os=windows`
    const browserCommand = `${origin}/install?os=browser`

    const copyInstall = (kind: 'unix' | 'win', value: string) => {
        navigator.clipboard.writeText(value)
        setInstallCopied(kind)
        setTimeout(() => setInstallCopied(null), 2000)
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
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

            <ConfirmDialog
                isOpen={pruneState.kind === 'confirm' || pruneState.kind === 'deleting'}
                onClose={() => setPruneState((prev) => (
                    // The dialog closes itself on success; keep the outcome on screen.
                    prev.kind === 'done' || prev.kind === 'error' ? prev : { kind: 'idle' }
                ))}
                title={t('settings.sessions.pruneEmpty')}
                description={t('settings.sessions.pruneEmpty.confirm', {
                    n: pruneState.kind === 'confirm' || pruneState.kind === 'deleting' ? pruneState.found : 0
                })}
                confirmLabel={t('button.delete')}
                confirmingLabel={t('misc.loading')}
                onConfirm={deleteEmptySessions}
                isPending={pruneState.kind === 'deleting'}
                destructive
            />

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto app-scroll-y">
                <div className="mx-auto w-full max-w-content pb-[env(safe-area-inset-bottom)]">
                    <SettingsIndexBar sections={sections} scrollRef={scrollRef} />

                    {/* Everything that changes how the app looks and reads. */}
                    <SettingsSection id="appearance" title={t('settings.section.appearance')}>
                        <SettingsSelectRow
                            label={t('settings.language.label')}
                            valueLabel={currentLocaleLabel}
                            selected={locale}
                            options={locales.map((entry) => ({ value: entry.value, label: entry.nativeLabel }))}
                            onSelect={setLocale}
                        />
                        <SettingsSelectRow
                            label={t('settings.display.appearance')}
                            valueLabel={currentAppearanceLabel}
                            selected={appearance}
                            options={appearanceOptions}
                            onSelect={setAppearance}
                        />
                        <SettingsSelectRow
                            label={t('settings.display.fontSize')}
                            valueLabel={currentFontScaleLabel}
                            selected={fontScale}
                            options={getFontScaleOptions()}
                            onSelect={setFontScale}
                        />
                        <SettingsSelectRow
                            label={t('settings.display.terminalFontSize')}
                            valueLabel={currentTerminalFontSizeLabel}
                            selected={terminalFontSize}
                            options={getTerminalFontSizeOptions()}
                            onSelect={setTerminalFontSize}
                        />
                    </SettingsSection>

                    {/* How the session chat itself behaves. */}
                    <SettingsSection id="chat" title={t('settings.section.chat')} description={t('settings.chat.pageSize.description')}>
                        <SettingsSelectRow
                            label={t('settings.chat.pageSize')}
                            valueLabel={String(chatPageSize)}
                            selected={chatPageSize}
                            options={getChatPageSizeOptions()}
                            onSelect={setChatPageSize}
                        />
                        <SettingsToggleRow
                            label={t('settings.display.rainbowText')}
                            checked={rainbowOn}
                            onChange={(next) => {
                                setRainbowOn(next)
                                setRainbowEnabled(next)
                            }}
                        />
                        <SettingsToggleRow
                            label={t('settings.display.performanceMonitor')}
                            checked={performanceMonitorOn}
                            onChange={(next) => {
                                setPerformanceMonitorOn(next)
                                setPerformanceMonitorEnabled(next)
                                window.location.reload()
                            }}
                        />
                    </SettingsSection>


                    {/* Housekeeping for the session list. */}
                    <SettingsSection
                        id="sessions"
                        title={t('settings.section.sessions')}
                        description={t('settings.sessions.pruneEmpty.description')}
                    >
                        <div className="px-3 pb-3">
                            <button
                                type="button"
                                onClick={() => void countEmptySessions()}
                                disabled={pruneState.kind === 'checking' || pruneState.kind === 'deleting'}
                                className="w-full rounded-lg border border-[var(--app-border)] px-3 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                            >
                                {pruneState.kind === 'checking' || pruneState.kind === 'deleting'
                                    ? t('misc.loading')
                                    : t('settings.sessions.pruneEmpty')}
                            </button>
                            {pruneState.kind === 'done' && (
                                <p className="mt-2 text-xs text-[var(--app-hint)]">
                                    {pruneState.deleted === 0 && pruneState.failed === 0
                                        ? t('settings.sessions.pruneEmpty.none')
                                        : t('settings.sessions.pruneEmpty.done', { n: pruneState.deleted })}
                                    {pruneState.failed > 0
                                        ? ` ${t('settings.sessions.pruneEmpty.failed', { n: pruneState.failed })}`
                                        : ''}
                                </p>
                            )}
                            {pruneState.kind === 'error' && (
                                <p className="mt-2 text-xs text-red-500">{pruneState.message}</p>
                            )}
                        </div>
                    </SettingsSection>

                    <SettingsSection id="voice" title={t('settings.voice.title')}>
                        <SettingsSelectRow
                            label={t('settings.voice.language')}
                            valueLabel={currentVoiceLanguageLabel}
                            selected={voiceLanguage}
                            options={voiceLanguageOptions}
                            onSelect={handleVoiceLanguageChange}
                            wide
                        />
                    </SettingsSection>

                    {/* What every agent starts with, and what its tokens cost. */}
                    <SettingsSection id="system-prompt" title={t('settings.systemPrompt.title')} description={t('settings.systemPrompt.description')}>
                        <div className="px-3 pb-3">
                            <textarea
                                value={globalPrompt}
                                onChange={(e) => setGlobalPrompt(e.target.value)}
                                placeholder={t('settings.systemPrompt.placeholder')}
                                className="max-h-[300px] min-h-[100px] w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"
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
                                            className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                                        >
                                            {savingPrompt ? t('dialog.properties.saving') : t('button.save')}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </SettingsSection>

                    <SettingsSection id="model-pricing" title={t('settings.modelPricing.title')} description={t('settings.modelPricing.description')}>
                        <div className="space-y-2 px-3 pb-3">
                            {(pricingData?.pricing ?? []).map((pricing) => (
                                <div key={pricing.model} className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] px-2 py-1.5 text-xs">
                                    <span className="min-w-0 flex-1 truncate font-medium">{pricing.model}</span>
                                    <span className="tabular-nums text-[var(--app-hint)]">${pricing.inputPerMillion} / ${pricing.outputPerMillion} / ${pricing.cachedInputPerMillion}</span>
                                    <button type="button" onClick={() => void deletePricing(pricing)} className="text-red-500">{t('button.delete')}</button>
                                </div>
                            ))}
                            <div className="grid grid-cols-4 gap-2">
                                <input value={pricingDraft.model} onChange={(e) => setPricingDraft((value) => ({ ...value, model: e.target.value }))} placeholder={t('settings.modelPricing.model')} className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs" />
                                <input type="number" min="0" step="any" value={pricingDraft.input} onChange={(e) => setPricingDraft((value) => ({ ...value, input: e.target.value }))} placeholder={t('settings.modelPricing.input')} className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs" />
                                <input type="number" min="0" step="any" value={pricingDraft.output} onChange={(e) => setPricingDraft((value) => ({ ...value, output: e.target.value }))} placeholder={t('settings.modelPricing.output')} className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs" />
                                <input type="number" min="0" step="any" value={pricingDraft.cached} onChange={(e) => setPricingDraft((value) => ({ ...value, cached: e.target.value }))} placeholder={t('settings.modelPricing.cached')} className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs" />
                            </div>
                            <div className="flex justify-end">
                                <button type="button" disabled={savingPricing || !pricingDraft.model.trim()} onClick={() => void savePricing()} className="rounded-lg bg-[var(--app-link)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">{t('button.save')}</button>
                            </div>
                        </div>
                    </SettingsSection>

                    {/* The machines and speakers this account talks to. */}
                    <SettingsSection id="devices" title={t('settings.section.devices')}>
                        <SettingsLinkRow label={t('settings.nav.machines')} onClick={() => navigate({ to: '/machines' })} />
                        <SettingsLinkRow label={t('settings.nav.speakers')} onClick={() => navigate({ to: '/speakers' })} />
                    </SettingsSection>

                    <SettingsSection
                        id="add-device"
                        title={t('settings.section.addDevice')}
                        description={inviteData ? t('settings.addDevice.inviteDescription') : t('settings.addDevice.description')}
                    >
                        <div className="px-3 pb-3">
                            <InstallCommandRow
                                platform="Unix"
                                command={unixCommand}
                                copied={installCopied === 'unix'}
                                onCopy={() => copyInstall('unix', unixCommand)}
                            />
                            <InstallCommandRow
                                platform="Win"
                                command={windowsCommand}
                                copied={installCopied === 'win'}
                                onCopy={() => copyInstall('win', windowsCommand)}
                            />
                            <InstallCommandRow
                                platform="Browser"
                                command={browserCommand}
                                copied={false}
                                action="open"
                                onCopy={() => copyInstall('unix', browserCommand)}
                                onOpen={() => window.open(browserCommand, '_blank')}
                            />
                            {inviteData && (
                                <div className="mt-1.5 text-center text-[10px] text-[var(--app-hint)]">
                                    {t('settings.addDevice.expires', { at: new Date(inviteData.expiresAt).toLocaleString() })}
                                </div>
                            )}
                            <div className="mt-3 flex items-center gap-2">
                                <input
                                    type="text"
                                    placeholder={t('settings.addDevice.guestName')}
                                    value={guestName}
                                    onChange={(e) => setGuestName(e.target.value)}
                                    className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={async () => {
                                        setCreatingInvite(true)
                                        try {
                                            const name = guestName.trim() || undefined
                                            const result = await api.createInvite(name)
                                            setInviteData({ token: result.token, expiresAt: result.expiresAt })
                                        } catch { /* ignore */ }
                                        finally { setCreatingInvite(false) }
                                    }}
                                    disabled={creatingInvite}
                                    className="shrink-0 rounded-lg bg-[var(--app-link)] px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                                >
                                    {creatingInvite ? '...' : inviteData ? t('settings.addDevice.regenerate') : t('settings.addDevice.quickJoin')}
                                </button>
                            </div>
                        </div>
                    </SettingsSection>

                    {/* Who may act as this account. */}
                    <SettingsSection id="security" title={t('settings.section.security')}>
                        <SettingsLinkRow label={t('settings.nav.credentials')} onClick={() => navigate({ to: '/credentials' })} />
                        <SettingsLinkRow label={t('settings.nav.apiKeys')} onClick={() => navigate({ to: '/keys' })} />
                    </SettingsSection>

                    <SettingsSection id="about" title={t('settings.about.title')}>
                        <SettingsInfoRow label={t('settings.about.website')}>
                            <a
                                href="https://hapi.run"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--app-link)] hover:underline"
                            >
                                hapi.run
                            </a>
                        </SettingsInfoRow>
                        <SettingsInfoRow label={t('settings.about.appVersion')}>
                            <span className="text-[var(--app-hint)]">{__APP_VERSION__}</span>
                        </SettingsInfoRow>
                        <SettingsInfoRow label={t('settings.about.protocolVersion')}>
                            <span className="text-[var(--app-hint)]">{PROTOCOL_VERSION}</span>
                        </SettingsInfoRow>
                    </SettingsSection>

                    {logout && (
                        <div className="py-4">
                            <button
                                type="button"
                                onClick={logout}
                                className="flex w-full items-center justify-center rounded-lg px-3 py-3 text-red-500 transition-colors hover:bg-[var(--app-subtle-bg)]"
                            >
                                {t('settings.logOut')}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
