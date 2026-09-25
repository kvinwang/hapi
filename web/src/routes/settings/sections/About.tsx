import { useState } from 'react'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'
import { isPerformanceMonitorEnabled, setPerformanceMonitorEnabled } from '@/components/PerformanceMonitor'
import { SettingsInfoRow, SettingsSection, SettingsToggleRow } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'

export default function AboutSettings() {
    const { t } = useTranslation()
    const [performanceMonitorOn, setPerformanceMonitorOn] = useState(() => isPerformanceMonitorEnabled())

    return (
        <SettingsScreen title={t('settings.about.title')}>
            <SettingsSection>
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
            <SettingsSection title={t('settings.section.diagnostics')}>
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
        </SettingsScreen>
    )
}
