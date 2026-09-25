import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useApiKeys } from '@/hooks/queries/useApiKeys'
import { SettingsLinkRow, SettingsLogOutButton, SettingsSection } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'

export default function AccountSettings() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { api, logout } = useAppContext()
    const { apiKeys, isLoading } = useApiKeys(api, true)
    const active = apiKeys.filter((key) => key.revokedAt === null).length

    return (
        <SettingsScreen title={t('settings.group.account')}>
            <SettingsSection description={t('settings.apiKeys.description')}>
                <SettingsLinkRow
                    label={t('settings.nav.apiKeys')}
                    value={isLoading ? undefined : String(active)}
                    onClick={() => navigate({ to: '/settings/account/keys' })}
                />
            </SettingsSection>
            <div className="py-4">
                <SettingsLogOutButton label={t('settings.logOut')} onLogOut={logout} />
            </div>
        </SettingsScreen>
    )
}
