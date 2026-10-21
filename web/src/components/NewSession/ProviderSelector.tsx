import { credentialProtocolFor, isSessionCredentialAgent } from '@hapi/protocol'
import type { Credential } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import type { AgentType } from './types'

export function compatibleCredentials(credentials: Credential[], agent: AgentType): Credential[] {
    if (!isSessionCredentialAgent(agent)) return []
    return credentials.filter((credential) => credentialProtocolFor(credential.config, agent))
}

export function ProviderSelector(props: {
    agent: AgentType
    credentials: Credential[]
    credentialId: string | undefined
    isDisabled: boolean
    onCredentialChange: (credential: Credential | undefined) => void
}) {
    const { t } = useTranslation()
    const options = compatibleCredentials(props.credentials, props.agent)
    if (options.length === 0) return null

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.provider')}
            </label>
            <select
                value={props.credentialId ?? ''}
                onChange={(e) => props.onCredentialChange(options.find((credential) => credential.id === e.target.value))}
                disabled={props.isDisabled}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="">{t('newSession.providerDefault')}</option>
                {options.map((credential) => (
                    <option key={credential.id} value={credential.id}>{credential.name}</option>
                ))}
            </select>
        </div>
    )
}
