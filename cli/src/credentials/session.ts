import { z } from 'zod'
import { CredentialConfigSchema, credentialProtocolFor, type SessionCredentialAgent } from '@hapi/protocol'

const SessionCredentialSchema = z.object({
    credentialId: z.string().min(1),
    name: z.string().min(1),
    config: CredentialConfigSchema
})

export type SessionCredential = z.infer<typeof SessionCredentialSchema>

/**
 * One-shot credential handed to a freshly spawned session. Removed from the
 * environment immediately so agent child processes never inherit it.
 */
export function takeSessionCredential(agent: SessionCredentialAgent): SessionCredential | null {
    const raw = process.env.HAPI_SESSION_CREDENTIAL
    if (!raw) return null
    delete process.env.HAPI_SESSION_CREDENTIAL
    const parsed = SessionCredentialSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) throw new Error('Invalid session credential')
    if (!credentialProtocolFor(parsed.data.config, agent)) {
        throw new Error(`Credential is not compatible with ${agent}`)
    }
    return parsed.data
}

export function sessionProviderMetadata(credential: SessionCredential) {
    return {
        provider: { source: 'credential' as const, credentialId: credential.credentialId },
        name: credential.name
    }
}
