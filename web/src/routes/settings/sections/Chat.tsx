import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { queryKeys } from '@/lib/query-keys'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName } from '@/lib/languages'
import { isRainbowEnabled, setRainbowEnabled } from '@/components/LazyRainbowText'
import { VOICE_ENVIRONMENTS, getVoiceEnvironment, isVoiceEdgeGlowEnabled, isVoiceReadRepliesEnabled, setVoiceEdgeGlowEnabled, setVoiceEnvironment, setVoiceReadRepliesEnabled, type VoiceEnvironment } from '@/components/VoiceOrb'
import { STALE_CACHE_IDLE_OPTIONS_MS, formatIdleDuration, getStaleCacheIdleMs, setStaleCacheIdleMs } from '@/chat/staleCacheWarning'
import { getChatPageSizeOptions } from '@/hooks/useChatPageSize'
import { SettingsInfoRow, SettingsLinkRow, SettingsSection, SettingsSelectRow, SettingsToggleRow } from '@/routes/settings/controls'
import { inputClass, primaryButtonClass, secondaryButtonClass } from '@/routes/settings/providers/CredentialForm'
import { SettingsScreen } from '@/routes/settings/header'
import { useSettingsState } from '@/routes/settings/state'

const voiceLanguages = getElevenLabsSupportedLanguages()

function DictationKeyEditor() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const { data: preferences } = useQuery({ queryKey: queryKeys.preferences, queryFn: () => api.getPreferences() })
    const [key, setKey] = useState('')
    const save = useMutation({
        mutationFn: (dashscopeApiKey: string) => api.updatePreferences({ dashscopeApiKey }),
        onSuccess: (result) => {
            queryClient.setQueryData(queryKeys.preferences, result)
            setKey('')
        }
    })
    const configured = preferences?.dashscopeConfigured ?? false

    return (
        <>
            <SettingsInfoRow label={t('settings.dictation.apiKey')}>
                <span className="text-[var(--app-hint)]">
                    {configured ? t('settings.dictation.configured') : t('settings.dictation.notSet')}
                </span>
            </SettingsInfoRow>
            <div className="flex gap-2 px-3 pb-3">
                <input className={`${inputClass} min-w-0 flex-1 font-mono`} type="password" autoComplete="off"
                    placeholder={t('settings.dictation.placeholder')} value={key} onChange={(e) => setKey(e.target.value)} />
                <button type="button" className={primaryButtonClass} disabled={!key.trim() || save.isPending}
                    onClick={() => save.mutate(key)}>{t('button.save')}</button>
                {configured ? (
                    <button type="button" className={secondaryButtonClass} disabled={save.isPending}
                        onClick={() => save.mutate('')}>{t('settings.dictation.remove')}</button>
                ) : null}
            </div>
        </>
    )
}

export default function ChatSettings() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { api } = useAppContext()
    const quickPhrases = useQuickPhrases(api)
    const { chatPageSize, setChatPageSize } = useSettingsState()
    const [rainbowOn, setRainbowOn] = useState(() => isRainbowEnabled())
    const [edgeGlowOn, setEdgeGlowOn] = useState(isVoiceEdgeGlowEnabled)
    const [readRepliesOn, setReadRepliesOn] = useState(isVoiceReadRepliesEnabled)
    const [environment, setEnvironment] = useState(getVoiceEnvironment)
    const environmentOptions = (Object.keys(VOICE_ENVIRONMENTS) as VoiceEnvironment[])
        .map((value) => ({ value, label: t(`settings.voice.environment.${value}`) }))
    const [staleCacheIdleMs, setStaleCacheIdleMsState] = useState(getStaleCacheIdleMs)
    const [voiceLanguage, setVoiceLanguage] = useState<string | null>(() => localStorage.getItem('hapi-voice-lang'))

    const voiceLanguageOptions = voiceLanguages.map((language) => ({
        value: language.code,
        label: language.code === null ? t('settings.voice.autoDetect') : getLanguageDisplayName(language)
    }))

    const handleVoiceLanguageChange = (code: string | null) => {
        setVoiceLanguage(code)
        if (code === null) {
            localStorage.removeItem('hapi-voice-lang')
        } else {
            localStorage.setItem('hapi-voice-lang', code)
        }
    }

    return (
        <SettingsScreen title={t('settings.section.chat')}>
            <SettingsSection description={t('settings.quickPhrases.description')}>
                <SettingsLinkRow
                    label={t('settings.nav.quickPhrases')}
                    value={quickPhrases.isLoading ? undefined : String(quickPhrases.phrases.length)}
                    onClick={() => navigate({ to: '/settings/chat/phrases' })}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.chat.history')} description={t('settings.chat.pageSize.description')}>
                <SettingsSelectRow
                    label={t('settings.chat.pageSize')}
                    valueLabel={String(chatPageSize)}
                    selected={chatPageSize}
                    options={getChatPageSizeOptions()}
                    onSelect={setChatPageSize}
                />
                <SettingsSelectRow
                    label={t('settings.chat.staleCacheIdle')}
                    valueLabel={formatIdleDuration(staleCacheIdleMs, t)}
                    selected={staleCacheIdleMs}
                    options={STALE_CACHE_IDLE_OPTIONS_MS.map((ms) => ({ value: ms, label: formatIdleDuration(ms, t) }))}
                    onSelect={(ms) => {
                        setStaleCacheIdleMsState(ms)
                        setStaleCacheIdleMs(ms)
                    }}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.display.title')}>
                <SettingsToggleRow
                    label={t('settings.display.rainbowText')}
                    checked={rainbowOn}
                    onChange={(next) => {
                        setRainbowOn(next)
                        setRainbowEnabled(next)
                    }}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.voice.title')}>
                <SettingsSelectRow
                    label={t('settings.voice.language')}
                    valueLabel={voiceLanguageOptions.find((option) => option.value === voiceLanguage)?.label
                        ?? t('settings.voice.autoDetect')}
                    selected={voiceLanguage}
                    options={voiceLanguageOptions}
                    onSelect={handleVoiceLanguageChange}
                    wide
                />
                <SettingsSelectRow
                    label={t('settings.voice.environment')}
                    valueLabel={t(`settings.voice.environment.${environment}`)}
                    selected={environment}
                    options={environmentOptions}
                    onSelect={(value) => {
                        setEnvironment(value)
                        setVoiceEnvironment(value)
                    }}
                />
                <SettingsToggleRow
                    label={t('settings.voice.readReplies')}
                    checked={readRepliesOn}
                    onChange={(next) => {
                        setReadRepliesOn(next)
                        setVoiceReadRepliesEnabled(next)
                    }}
                />
                <SettingsToggleRow
                    label={t('settings.voice.edgeGlow')}
                    checked={edgeGlowOn}
                    onChange={(next) => {
                        setEdgeGlowOn(next)
                        setVoiceEdgeGlowEnabled(next)
                    }}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.dictation.title')} description={t('settings.dictation.description')}>
                <DictationKeyEditor />
            </SettingsSection>
        </SettingsScreen>
    )
}
