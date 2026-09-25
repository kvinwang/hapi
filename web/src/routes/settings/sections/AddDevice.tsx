import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { SettingsSection } from '@/routes/settings/controls'
import { SettingsScreen } from '@/routes/settings/header'

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

function CopyIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
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

export default function AddDevicePage() {
    const { t } = useTranslation()
    const { api } = useAppContext()
    const [installCopied, setInstallCopied] = useState<'unix' | 'win' | null>(null)
    const [inviteData, setInviteData] = useState<{ token: string; expiresAt: number } | null>(null)
    const [creatingInvite, setCreatingInvite] = useState(false)
    const [guestName, setGuestName] = useState('')

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
        <SettingsScreen title={t('settings.section.addDevice')}>
            <SettingsSection
                title={t('settings.addDevice.install')}
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
                </div>
            </SettingsSection>
            <SettingsSection title={t('settings.addDevice.quickJoin')} description={t('settings.addDevice.quickJoinDescription')}>
                <div className="flex items-center gap-2 px-3 pb-3">
                    <input
                        type="text"
                        placeholder={t('settings.addDevice.guestName')}
                        value={guestName}
                        onChange={(e) => setGuestName(e.target.value)}
                        className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-[var(--app-link)] focus:outline-none"
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
            </SettingsSection>
        </SettingsScreen>
    )
}
