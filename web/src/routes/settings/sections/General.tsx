import { useTranslation, type Locale } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { getFontScaleOptions, useFontScale } from '@/hooks/useFontScale'
import { getTerminalFontSizeOptions, useTerminalFontSize } from '@/hooks/useTerminalFontSize'
import { getAppearanceOptions } from '@/hooks/useTheme'
import { openLiteUi } from '@/lib/lite-handoff'
import { SettingsLinkRow, SettingsSection, SettingsSelectRow } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'
import { useSessionHeaderStyle, useSessionHeaderPosition, type SessionHeaderStyle, type SessionHeaderPosition } from '@/hooks/useSessionHeaderStyle'
import { useSettingsState } from '@/routes/settings/state'

export const locales: { value: Locale; nativeLabel: string }[] = [
    { value: 'en', nativeLabel: 'English' },
    { value: 'zh-CN', nativeLabel: '简体中文' },
]

export default function GeneralSettings() {
    const { t, locale, setLocale } = useTranslation()
    const { baseUrl } = useAppContext()
    const { fontScale, setFontScale } = useFontScale()
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { headerStyle, setHeaderStyle } = useSessionHeaderStyle()
    const { headerPosition, setHeaderPosition } = useSessionHeaderPosition()
    const { appearance, setAppearance } = useSettingsState()

    const appearanceOptions = getAppearanceOptions().map((option) => ({
        value: option.value,
        label: t(option.labelKey)
    }))

    return (
        <SettingsScreen title={t('settings.group.general')}>
            <SettingsSection>
                <SettingsSelectRow
                    label={t('settings.language.label')}
                    valueLabel={locales.find((entry) => entry.value === locale)?.nativeLabel ?? 'English'}
                    selected={locale}
                    options={locales.map((entry) => ({ value: entry.value, label: entry.nativeLabel }))}
                    onSelect={setLocale}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.display.title')}>
                <SettingsSelectRow
                    label={t('settings.display.appearance')}
                    valueLabel={appearanceOptions.find((option) => option.value === appearance)?.label
                        ?? t('settings.display.appearance.system')}
                    selected={appearance}
                    options={appearanceOptions}
                    onSelect={setAppearance}
                />
                <SettingsSelectRow
                    label={t('settings.display.fontSize')}
                    valueLabel={getFontScaleOptions().find((option) => option.value === fontScale)?.label ?? '100%'}
                    selected={fontScale}
                    options={getFontScaleOptions()}
                    onSelect={setFontScale}
                />
                <SettingsSelectRow
                    label={t('settings.display.terminalFontSize')}
                    valueLabel={getTerminalFontSizeOptions().find((option) => option.value === terminalFontSize)?.label ?? '13px'}
                    selected={terminalFontSize}
                    options={getTerminalFontSizeOptions()}
                    onSelect={setTerminalFontSize}
                />
                <SettingsSelectRow
                    label={t('settings.display.sessionHeader')}
                    valueLabel={t(`settings.display.sessionHeader.${headerStyle}`)}
                    selected={headerStyle}
                    options={(['auto', 'compact', 'expanded'] as SessionHeaderStyle[]).map((value) => ({ value, label: t(`settings.display.sessionHeader.${value}`) }))}
                    onSelect={setHeaderStyle}
                />
                <SettingsSelectRow
                    label={t('settings.display.sessionHeaderPosition')}
                    valueLabel={t(`settings.display.sessionHeaderPosition.${headerPosition}`)}
                    selected={headerPosition}
                    options={(['auto', 'top', 'bottom'] as SessionHeaderPosition[]).map((value) => ({ value, label: t(`settings.display.sessionHeaderPosition.${value}`) }))}
                    onSelect={setHeaderPosition}
                />
                <SettingsLinkRow label={t('settings.display.liteUi')} onClick={() => openLiteUi(baseUrl)} />
            </SettingsSection>
        </SettingsScreen>
    )
}
