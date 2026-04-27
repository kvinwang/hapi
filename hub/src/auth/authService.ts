import { SignJWT, jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'

import type { Store } from '../store'
import type { Permission } from '../store/types'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
import { hashApiKey } from '../utils/apiKey'
import type { RevocationCache } from './revocationCache'

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
            .setExpirationTime('1h')
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
}
