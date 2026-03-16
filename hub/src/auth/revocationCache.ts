import type { AccessTokenStore } from '../store/accessTokenStore'
import type { ApiKeyStore } from '../store/apiKeyStore'

export class RevocationCache {
    private revokedAccessTokenIds = new Set<string>()
    private revokedApiKeyIds = new Set<string>()
    private cleanupTimer: ReturnType<typeof setInterval> | null = null

    constructor(
        private accessTokenStore: AccessTokenStore,
        private apiKeyStore: ApiKeyStore
    ) {}

    /** Load revoked entries from DB and start periodic cleanup */
    start(intervalMs: number = 60_000): void {
        this.rebuild()
        this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs)
    }

    stop(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
            this.cleanupTimer = null
        }
    }

    revokeAccessToken(id: string): void {
        this.revokedAccessTokenIds.add(id)
    }

    revokeApiKey(apiKeyId: string): void {
        this.revokedApiKeyIds.add(apiKeyId)
    }

    restoreAccessToken(id: string): void {
        this.revokedAccessTokenIds.delete(id)
    }

    restoreApiKey(apiKeyId: string): void {
        this.revokedApiKeyIds.delete(apiKeyId)
    }

    isAccessTokenRevoked(id: string): boolean {
        return this.revokedAccessTokenIds.has(id)
    }

    isApiKeyRevoked(apiKeyId: string): boolean {
        return this.revokedApiKeyIds.has(apiKeyId)
    }

    private rebuild(): void {
        // Load revoked access token IDs for non-expired tokens
        const tokenIds = this.accessTokenStore.getRevokedActiveIds()
        this.revokedAccessTokenIds = new Set(tokenIds)

        // Load all revoked API key IDs
        const apiKeys = this.apiKeyStore.listApiKeys()
        this.revokedApiKeyIds = new Set(
            apiKeys.filter(k => k.revokedAt !== null).map(k => k.id)
        )
    }

    private cleanup(): void {
        this.accessTokenStore.cleanupExpired()
        this.rebuild()
    }
}
