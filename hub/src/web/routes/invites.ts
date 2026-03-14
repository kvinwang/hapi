import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { hasPermission } from '../../auth/permissions'
import { generateApiKey, hashApiKey, extractKeyPrefix } from '../../utils/apiKey'
import type { Permission } from '../../store/types'

const GUEST_KEY_NAME = 'invited-guests'
const GUEST_PERMISSIONS: Permission[] = ['machines:write']

const createInviteSchema = z.object({
    ttlMinutes: z.number().int().min(5).max(1440).optional()
})

/**
 * Ensure the shared "invited-guests" API key exists for the given namespace.
 * Creates it if missing. Returns the API key ID.
 */
function ensureGuestApiKey(store: Store, namespace: string): string {
    const existing = store.apiKeys.listApiKeys()
        .find(k => k.namespace === namespace && k.name === GUEST_KEY_NAME && !k.revokedAt)
    if (existing) return existing.id

    const rawKey = generateApiKey()
    const id = randomUUID()
    store.apiKeys.createApiKey({
        id,
        name: GUEST_KEY_NAME,
        keyHash: hashApiKey(rawKey),
        keyPrefix: extractKeyPrefix(rawKey),
        namespace,
        permissions: GUEST_PERMISSIONS
    })
    return id
}

export function createInviteRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Create a guest access token — requires machines:manage
    app.post('/invites', async (c) => {
        const permissions = c.get('permissions') ?? []
        if (!hasPermission(permissions, 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const namespace = c.get('namespace')

        const body = await c.req.json().catch(() => ({}))
        const parsed = createInviteSchema.safeParse(body)
        const ttlMinutes = parsed.success ? (parsed.data.ttlMinutes ?? 30) : 30

        const guestKeyId = ensureGuestApiKey(store, namespace)

        // Create a time-limited access token under the guest key
        const rawToken = generateApiKey()
        const tokenId = randomUUID()
        const expiresAt = Date.now() + ttlMinutes * 60_000

        store.accessTokens.createToken({
            id: tokenId,
            apiKeyId: guestKeyId,
            name: `guest-${Date.now()}`,
            tokenHash: hashApiKey(rawToken),
            tokenPrefix: extractKeyPrefix(rawToken),
            namespace,
            permissions: GUEST_PERMISSIONS,
            expiresAt
        })

        const origin = new URL(c.req.url).origin
        const command = `curl -fsSL ${origin}/install | bash -s -- --join ${rawToken}`

        return c.json({
            ok: true,
            token: rawToken,
            expiresAt,
            command
        })
    })

    return app
}
