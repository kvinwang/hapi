import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { getElevenLabsSupportedLanguages, getLanguageDisplayName } from '@/lib/languages'
import { isRainbowEnabled, setRainbowEnabled } from '@/components/LazyRainbowText'
import { STALE_CACHE_IDLE_OPTIONS_MS, formatIdleDuration, getStaleCacheIdleMs, setStaleCacheIdleMs } from '@/chat/staleCacheWarning'
import { getChatPageSizeOptions } from '@/hooks/useChatPageSize'
import { SettingsSection, SettingsSelectRow, SettingsToggleRow } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'
import { useSettingsState } from '@/routes/settings/state'

const voiceLanguages = getElevenLabsSupportedLanguages()

export default function ChatSettings() {
    const { t } = useTranslation()
    const { chatPageSize, setChatPageSize } = useSettingsState()
    const [rainbowOn, setRainbowOn] = useState(() => isRainbowEnabled())
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
            </SettingsSection>
        </SettingsScreen>
    )
}
