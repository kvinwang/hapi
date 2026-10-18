import { SignJWT, jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'

import type { Store } from '../store'
import type { Permission } from '../store/types'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
import { hashApiKey } from '../utils/apiKey'
import { isSessionGrantUsable, type StoredSessionGrant } from '../store/sessionGrantStore'
import type { RevocationCache } from './revocationCache'

const MAX_GUEST_CODE_ATTEMPTS = 10

export type ApiKeyAuth = {
    apiKeyId: string
    accessTokenId: string | null
    namespace: string
    permissions: Permission[]
}

export type JwtAuth = {
    userId: number
    namespace: string
    permissions: Permission[]
    jti: string
    apiKeyId: string
    accessTokenId: string | null
}

/** A guest holding a session grant: may only interact with `sessionId`. */
export type GuestAuth = {
    grantId: string
    sessionId: string
    namespace: string
    allowVoice: boolean
}

function toGuestAuth(grant: StoredSessionGrant): GuestAuth {
    return { grantId: grant.id, sessionId: grant.sessionId, namespace: grant.namespace, allowVoice: grant.allowVoice }
}

export class AuthService {
    constructor(
        private store: Store,
        private revocationCache: RevocationCache,
        private jwtSecret: Uint8Array,
        private legacyToken: string
    ) {}

    /**
     * Authenticate a CLI access token (API key, access token, or legacy token).
     * Returns the auth info or null.
     */
    authenticateCliToken(rawToken: string): ApiKeyAuth | null {
        const parsed = parseAccessToken(rawToken)
        if (!parsed) return null

        const keyHash = hashApiKey(parsed.baseToken)

        // Try API key lookup first
        const apiKey = this.store.apiKeys.getApiKeyByHash(keyHash)
        if (apiKey && !apiKey.revokedAt) {
            this.store.apiKeys.updateLastUsed(apiKey.id)
            return {
                apiKeyId: apiKey.id,
                accessTokenId: null,
                namespace: parsed.namespace !== 'default' ? parsed.namespace : apiKey.namespace,
                permissions: apiKey.permissions
            }
        }

        // Try access token lookup
        const accessToken = this.store.accessTokens.getTokenByHash(keyHash)
        if (accessToken && !accessToken.revokedAt && (accessToken.expiresAt === 0 || accessToken.expiresAt > Date.now())) {
            // Also check parent API key is not revoked
            const parentKey = this.store.apiKeys.getApiKeyById(accessToken.apiKeyId)
            if (parentKey && !parentKey.revokedAt) {
                this.store.apiKeys.updateLastUsed(parentKey.id)
                return {
                    apiKeyId: accessToken.apiKeyId,
                    accessTokenId: accessToken.id,
                    namespace: parsed.namespace !== 'default' ? parsed.namespace : accessToken.namespace,
                    permissions: accessToken.permissions
                }
            }
        }

        // Fallback: legacy token (constant-time comparison)
        if (constantTimeEquals(parsed.baseToken, this.legacyToken)) {
            return {
                apiKeyId: '__legacy__',
                accessTokenId: null,
                namespace: parsed.namespace,
                permissions: ['admin'] as Permission[]
            }
        }

        return null
    }

    /**
     * Create a JWT for web session.
     */
    async createJwt(params: {
        apiKeyId: string
        accessTokenId?: string | null
        userId: number
        namespace: string
        permissions: Permission[]
    }): Promise<string> {
        const jti = randomUUID()

        const payload: Record<string, unknown> = {
            uid: params.userId,
            ns: params.namespace,
            jti,
            kid: params.apiKeyId,
            perms: params.permissions
        }
        if (params.accessTokenId) {
            payload.atid = params.accessTokenId
        }

        return await new SignJWT(payload)
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
            .sign(this.jwtSecret)
    }

    /**
     * Verify a JWT, checking revocation.
     * Compatible with pre-migration JWTs (no jti/kid).
     */
    async verifyJwt(token: string): Promise<JwtAuth | null> {
        try {
            const verified = await jwtVerify(token, this.jwtSecret, { algorithms: ['HS256'] })
            const payload = verified.payload as Record<string, unknown>

            // Guest tokens carry only a grant id and must never pass as a regular session.
            if (payload.gid !== undefined) return null

            const uid = payload.uid
            const ns = payload.ns
            if (typeof uid !== 'number' || typeof ns !== 'string') return null

            const jti = typeof payload.jti === 'string' ? payload.jti : ''
            const kid = typeof payload.kid === 'string' ? payload.kid : ''
            const atid = typeof payload.atid === 'string' ? payload.atid : null
            const perms = (Array.isArray(payload.perms) ? payload.perms : []) as Permission[]

            // Check revocation
            if (kid && this.revocationCache.isApiKeyRevoked(kid)) return null
            if (atid && this.revocationCache.isAccessTokenRevoked(atid)) return null

            return { userId: uid, namespace: ns, permissions: perms, jti, apiKeyId: kid, accessTokenId: atid }
        } catch {
            return null
        }
    }

    /**
     * Exchange a grant id and its code for the grant. Wrong codes count towards a
     * lockout, so the short code cannot be brute-forced through a leaked link.
     */
    authenticateGuest(grantId: string, code: string): GuestAuth | null {
        const grant = this.store.sessionGrants.get(grantId)
        if (!grant || !isSessionGrantUsable(grant)) return null
        if (!constantTimeEquals(hashApiKey(code.trim().toUpperCase()), grant.codeHash)) {
            this.store.sessionGrants.recordFailedAttempt(grantId, MAX_GUEST_CODE_ATTEMPTS)
            return null
        }
        return toGuestAuth(grant)
    }

    async createGuestJwt(grantId: string): Promise<string> {
        return await new SignJWT({ gid: grantId })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
            .sign(this.jwtSecret)
    }

    /** Verify a guest JWT against the live grant, so revocation and voice changes apply at once. */
    async verifyGuestJwt(token: string): Promise<GuestAuth | null> {
        try {
            const { payload } = await jwtVerify(token, this.jwtSecret, { algorithms: ['HS256'] })
            if (typeof payload.gid !== 'string') return null
            const grant = this.store.sessionGrants.get(payload.gid)
            if (!grant || !isSessionGrantUsable(grant)) return null
            return toGuestAuth(grant)
        } catch {
            return null
        }
    }
}
