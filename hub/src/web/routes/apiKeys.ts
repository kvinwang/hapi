import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { AuthService } from '../../auth/authService'
import type { RevocationCache } from '../../auth/revocationCache'
import { requirePermission } from '../../auth/permissions'
import { generateApiKey, hashApiKey, extractKeyPrefix } from '../../utils/apiKey'
import { randomUUID } from 'node:crypto'

const permissionValues = ['admin', 'api_keys:manage', 'sessions:read:all', 'machines:read:all'] as const

const createApiKeySchema = z.object({
    name: z.string().min(1).max(200),
    namespace: z.string().min(1).max(100).optional(),
    permissions: z.array(z.enum(permissionValues)).optional()
})

const updatePermissionsSchema = z.object({
    permissions: z.array(z.enum(permissionValues))
})

export function createApiKeyRoutes(store: Store, authService: AuthService, revocationCache: RevocationCache): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // List all API keys
    app.get('/api-keys', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const keys = store.apiKeys.listApiKeys()
        return c.json({
            apiKeys: keys.map(k => ({
                id: k.id,
                name: k.name,
                keyPrefix: k.keyPrefix,
                namespace: k.namespace,
                permissions: k.permissions,
                createdAt: k.createdAt,
                revokedAt: k.revokedAt,
                lastUsedAt: k.lastUsedAt
            }))
        })
    })

    // Create API key
    app.post('/api-keys', async (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const json = await c.req.json().catch(() => null)
        const parsed = createApiKeySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const rawKey = generateApiKey()
        const apiKey = store.apiKeys.createApiKey({
            id: randomUUID(),
            name: parsed.data.name,
            keyHash: hashApiKey(rawKey),
            keyPrefix: extractKeyPrefix(rawKey),
            namespace: parsed.data.namespace ?? c.get('namespace'),
            permissions: parsed.data.permissions ?? []
        })

        return c.json({
            apiKey: {
                id: apiKey.id,
                name: apiKey.name,
                keyPrefix: apiKey.keyPrefix,
                namespace: apiKey.namespace,
                permissions: apiKey.permissions,
                createdAt: apiKey.createdAt,
                revokedAt: apiKey.revokedAt,
                lastUsedAt: apiKey.lastUsedAt
            },
            rawKey
        }, 201)
    })

    // Update API key permissions
    app.put('/api-keys/:id', async (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const json = await c.req.json().catch(() => null)
        const parsed = updatePermissionsSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const id = c.req.param('id')
        const updated = store.apiKeys.updatePermissions(id, parsed.data.permissions)
        if (!updated) {
            return c.json({ error: 'API key not found or already revoked' }, 404)
        }

        return c.json({
            apiKey: {
                id: updated.id,
                name: updated.name,
                keyPrefix: updated.keyPrefix,
                namespace: updated.namespace,
                permissions: updated.permissions,
                createdAt: updated.createdAt,
                revokedAt: updated.revokedAt,
                lastUsedAt: updated.lastUsedAt
            }
        })
    })

    // Revoke API key
    app.delete('/api-keys/:id', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const id = c.req.param('id')
        const revoked = store.apiKeys.revokeApiKey(id)
        if (!revoked) {
            return c.json({ error: 'API key not found or already revoked' }, 404)
        }

        // Cascade: revoke all access tokens for this key
        store.accessTokens.revokeTokensByApiKey(id)
        revocationCache.revokeApiKey(id)

        return c.json({ ok: true })
    })

    // List access tokens for an API key
    app.get('/api-keys/:id/tokens', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const tokens = store.accessTokens.listTokensByApiKey(c.req.param('id'))
        return c.json({
            tokens: tokens.map(t => ({
                id: t.id,
                apiKeyId: t.apiKeyId,
                name: t.name,
                tokenPrefix: t.tokenPrefix,
                namespace: t.namespace,
                permissions: t.permissions,
                createdAt: t.createdAt,
                expiresAt: t.expiresAt,
                revokedAt: t.revokedAt
            }))
        })
    })

    // Revoke specific access token
    app.delete('/api-keys/:id/tokens/:tokenId', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const tokenId = c.req.param('tokenId')
        const revoked = store.accessTokens.revokeToken(tokenId)
        if (!revoked) {
            return c.json({ error: 'Token not found or already revoked' }, 404)
        }

        revocationCache.revokeAccessToken(tokenId)

        return c.json({ ok: true })
    })

    return app
}
