import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { AuthService } from '../../auth/authService'
import type { RevocationCache } from '../../auth/revocationCache'
import { requirePermission } from '../../auth/permissions'
import { generateApiKey, hashApiKey, extractKeyPrefix } from '../../utils/apiKey'
import { randomUUID } from 'node:crypto'

const permissionValues = ['admin', 'api_keys:manage', 'sessions:read', 'sessions:read:all', 'sessions:write', 'machines:read', 'machines:read:all', 'machines:write', 'machines:manage', 'machines:ssh:manage'] as const

const createApiKeySchema = z.object({
    name: z.string().min(1).max(200),
    namespace: z.string().min(1).max(100).optional(),
    permissions: z.array(z.enum(permissionValues)).optional()
})

const updateApiKeySchema = z.object({
    name: z.string().min(1).max(200).optional(),
    permissions: z.array(z.enum(permissionValues)).optional()
})

const updateAccessTokenSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    expiresIn: z.enum(['1d', '7d', '30d', 'never']).optional()
})

const createAccessTokenSchema = z.object({
    name: z.string().min(1).max(200),
    expiresIn: z.enum(['1d', '7d', '30d', 'never'])
})

export function createApiKeyRoutes(store: Store, authService: AuthService, revocationCache: RevocationCache): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // List all API keys
    app.get('/api-keys', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const keys = store.apiKeys.listApiKeys(c.get('namespace'))
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

    // Update API key (name and/or permissions)
    app.put('/api-keys/:id', async (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const id = c.req.param('id')
        const existing = store.apiKeys.getApiKeyById(id)
        if (!existing || existing.namespace !== c.get('namespace')) {
            return c.json({ error: 'API key not found or already revoked' }, 404)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = updateApiKeySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const updated = store.apiKeys.updateApiKey(id, {
            name: parsed.data.name,
            permissions: parsed.data.permissions
        })
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
        const toRevoke = store.apiKeys.getApiKeyById(id)
        if (!toRevoke || toRevoke.namespace !== c.get('namespace')) {
            return c.json({ error: 'API key not found or already revoked' }, 404)
        }

        const revoked = store.apiKeys.revokeApiKey(id)
        if (!revoked) {
            return c.json({ error: 'API key not found or already revoked' }, 404)
        }

        // Cascade: revoke all access tokens for this key
        store.accessTokens.revokeTokensByApiKey(id)
        revocationCache.revokeApiKey(id)

        return c.json({ ok: true })
    })

    // Restore revoked API key
    app.post('/api-keys/:id/restore', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const id = c.req.param('id')
        const toRestore = store.apiKeys.getApiKeyById(id)
        if (!toRestore || toRestore.namespace !== c.get('namespace')) {
            return c.json({ error: 'API key not found or not revoked' }, 404)
        }

        const restored = store.apiKeys.restoreApiKey(id)
        if (!restored) {
            return c.json({ error: 'API key not found or not revoked' }, 404)
        }

        revocationCache.restoreApiKey(id)

        return c.json({ ok: true })
    })

    // List access tokens for an API key
    app.get('/api-keys/:id/tokens', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const parentKey = store.apiKeys.getApiKeyById(c.req.param('id'))
        if (!parentKey || parentKey.namespace !== c.get('namespace')) {
            return c.json({ error: 'API key not found' }, 404)
        }

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

    // Create access token for an API key
    app.post('/api-keys/:id/tokens', async (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const apiKeyId = c.req.param('id')
        const apiKey = store.apiKeys.getApiKeyById(apiKeyId)
        if (!apiKey || apiKey.revokedAt || apiKey.namespace !== c.get('namespace')) {
            return c.json({ error: 'API key not found or revoked' }, 404)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = createAccessTokenSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const expiresAt = (() => {
            switch (parsed.data.expiresIn) {
                case '1d': return Date.now() + 24 * 60 * 60 * 1000
                case '7d': return Date.now() + 7 * 24 * 60 * 60 * 1000
                case '30d': return Date.now() + 30 * 24 * 60 * 60 * 1000
                case 'never': return 0
            }
        })()

        const rawToken = generateApiKey()
        const token = store.accessTokens.createToken({
            id: randomUUID(),
            apiKeyId,
            name: parsed.data.name,
            tokenHash: hashApiKey(rawToken),
            tokenPrefix: extractKeyPrefix(rawToken),
            namespace: apiKey.namespace,
            permissions: apiKey.permissions,
            expiresAt
        })

        return c.json({
            token: {
                id: token.id,
                apiKeyId: token.apiKeyId,
                name: token.name,
                tokenPrefix: token.tokenPrefix,
                namespace: token.namespace,
                permissions: token.permissions,
                createdAt: token.createdAt,
                expiresAt: token.expiresAt,
                revokedAt: token.revokedAt
            },
            rawToken
        }, 201)
    })

    // Update access token (name and/or expiry)
    app.put('/api-keys/:id/tokens/:tokenId', async (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const tokenId = c.req.param('tokenId')
        const token = store.accessTokens.getToken(tokenId)
        if (!token) {
            return c.json({ error: 'Token not found' }, 404)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = updateAccessTokenSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const expiresAt = parsed.data.expiresIn !== undefined ? (() => {
            switch (parsed.data.expiresIn) {
                case '1d': return Date.now() + 24 * 60 * 60 * 1000
                case '7d': return Date.now() + 7 * 24 * 60 * 60 * 1000
                case '30d': return Date.now() + 30 * 24 * 60 * 60 * 1000
                case 'never': return 0
            }
        })() : undefined

        const updated = store.accessTokens.updateToken(tokenId, {
            name: parsed.data.name,
            expiresAt,
        })
        if (!updated) {
            return c.json({ error: 'Failed to update token' }, 500)
        }

        return c.json({
            token: {
                id: updated.id,
                apiKeyId: updated.apiKeyId,
                name: updated.name,
                tokenPrefix: updated.tokenPrefix,
                namespace: updated.namespace,
                permissions: updated.permissions,
                createdAt: updated.createdAt,
                expiresAt: updated.expiresAt,
                revokedAt: updated.revokedAt
            }
        })
    })

    // Restore revoked access token
    app.post('/api-keys/:id/tokens/:tokenId/restore', (c) => {
        const denied = requirePermission(c, 'api_keys:manage')
        if (denied) return denied

        const tokenId = c.req.param('tokenId')
        const restored = store.accessTokens.restoreToken(tokenId)
        if (!restored) {
            return c.json({ error: 'Token not found or not revoked' }, 404)
        }

        revocationCache.restoreAccessToken(tokenId)
        return c.json({ ok: true })
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
