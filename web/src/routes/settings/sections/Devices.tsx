import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useManagedMachines } from '@/hooks/queries/useMachines'
import { useSpeakers } from '@/hooks/queries/useSpeakers'
import { SettingsLinkRow, SettingsSection } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'

export default function DevicesSettings() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { api } = useAppContext()
    const machines = useManagedMachines(api)
    const speakers = useSpeakers(api)
    const online = machines.machines.filter((machine) => machine.active).length

    return (
        <SettingsScreen title={t('settings.section.devices')}>
            <SettingsSection>
                <SettingsLinkRow
                    label={t('settings.nav.machines')}
                    value={machines.isLoading ? undefined : t('settings.summary.machines', { online, total: machines.machines.length })}
                    onClick={() => navigate({ to: '/settings/devices/machines' })}
                />
                <SettingsLinkRow
                    label={t('settings.section.addDevice')}
                    onClick={() => navigate({ to: '/settings/devices/add' })}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.voice.title')}>
                <SettingsLinkRow
                    label={t('settings.nav.speakers')}
                    value={speakers.isLoading ? undefined : String(speakers.speakers.length)}
                    onClick={() => navigate({ to: '/settings/devices/speakers' })}
                />
            </SettingsSection>
        </SettingsScreen>
    )
}
