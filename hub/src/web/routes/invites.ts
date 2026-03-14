import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { hasPermission } from '../../auth/permissions'
import { generateApiKey, hashApiKey, extractKeyPrefix } from '../../utils/apiKey'

function generateInviteCode(): string {
    // 6-char alphanumeric code (easy to type)
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
    const bytes = randomBytes(6)
    return Array.from(bytes).map(b => chars[b % chars.length]).join('')
}

const createInviteSchema = z.object({
    ttlMinutes: z.number().int().min(5).max(1440).optional()
})

/**
 * @param store - Store instance
 * @param authenticated - if true, register auth-required routes (create/list); if false, register public routes (redeem)
 */
export function createInviteRoutes(store: Store, authenticated: boolean): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    if (!authenticated) {
        // Redeem invite — public (no auth required)
        // Returns a temporary API token for runner connection
        app.post('/invites/redeem', async (c) => {
            const body = await c.req.json().catch(() => null)
            if (!body || typeof body.code !== 'string') {
                return c.json({ error: 'Missing invite code' }, 400)
            }

            const code = body.code.trim().toLowerCase()
            const machineId = typeof body.machineId === 'string' ? body.machineId : undefined

            const invite = store.invites.redeem(code, machineId ?? 'anonymous')
            if (!invite) {
                return c.json({ error: 'Invalid or expired invite code' }, 404)
            }

            // Create a temporary API key for the runner
            const rawKey = generateApiKey()
            const keyHash = hashApiKey(rawKey)
            const keyPrefix = extractKeyPrefix(rawKey)
            const keyId = randomUUID()

            store.apiKeys.createApiKey({
                id: keyId,
                name: `invite:${code}`,
                keyHash,
                keyPrefix,
                namespace: invite.namespace,
                permissions: ['machines:write']
            })

            return c.json({
                ok: true,
                token: rawKey,
                namespace: invite.namespace
            })
        })
    } else {
        // Create invite — requires machines:manage
        app.post('/invites', async (c) => {
            const permissions = c.get('permissions') ?? []
            if (!hasPermission(permissions, 'machines:manage')) {
                return c.json({ error: 'Insufficient permissions' }, 403)
            }

            const namespace = c.get('namespace')
            const userId = String(c.get('userId') ?? 'unknown')

            const body = await c.req.json().catch(() => ({}))
            const parsed = createInviteSchema.safeParse(body)
            const ttlMinutes = parsed.success ? (parsed.data.ttlMinutes ?? 30) : 30

            const id = randomUUID()
            const code = generateInviteCode()
            const expiresAt = Date.now() + ttlMinutes * 60_000

            const invite = store.invites.create({
                id,
                code,
                namespace,
                createdBy: userId,
                expiresAt
            })

            const origin = new URL(c.req.url).origin
            const command = `curl -fsSL ${origin}/install | bash -s -- --join ${code}`

            return c.json({
                ok: true,
                code: invite.code,
                expiresAt: invite.expiresAt,
                command
            })
        })

        // List invites
        app.get('/invites', (c) => {
            const permissions = c.get('permissions') ?? []
            if (!hasPermission(permissions, 'machines:manage')) {
                return c.json({ error: 'Insufficient permissions' }, 403)
            }

            const namespace = c.get('namespace')
            const invites = store.invites.listByNamespace(namespace)
            return c.json({ invites })
        })
    }

    return app
}
