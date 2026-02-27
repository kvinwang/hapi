import { randomBytes, createHash } from 'node:crypto'

const API_KEY_PREFIX = 'hapi_'

/** Generate a new API key: hapi_ + 32 bytes base64url (~43 chars) */
export function generateApiKey(): string {
    return API_KEY_PREFIX + randomBytes(32).toString('base64url')
}

/** SHA-256 hash of an API key for storage */
export function hashApiKey(key: string): string {
    return createHash('sha256').update(key).digest('hex')
}

/** First 12 chars for display (includes 'hapi_' prefix + 7 chars) */
export function extractKeyPrefix(key: string): string {
    return key.slice(0, 12)
}
