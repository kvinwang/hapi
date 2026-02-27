import { Hono } from 'hono'
import { randomBytes, randomUUID } from 'node:crypto'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { AuthService } from '../../auth/authService'
import { generateApiKey, hashApiKey, extractKeyPrefix } from '../../utils/apiKey'

const QR_SESSION_TTL_MS = 5 * 60 * 1000 // 5 minutes

// Expiry presets in milliseconds (0 = never expires)
const EXPIRY_PRESETS: Record<string, number> = {
    'never': 0,
    '1d': 1 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    '365d': 365 * 24 * 60 * 60 * 1000,
}

const DEFAULT_EXPIRY = 'never'

interface QrSession {
    id: string
    secret: string
    status: 'pending' | 'confirmed'
    createdAt: number
    // Set on confirm: the access token for the new terminal
    accessToken?: string
}

const qrSessions = new Map<string, QrSession>()

function cleanupExpired() {
    const now = Date.now()
    for (const [id, session] of qrSessions) {
        if (now - session.createdAt > QR_SESSION_TTL_MS) {
            qrSessions.delete(id)
        }
    }
}

export function createQrRoutes(store: Store, authService: AuthService): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Create a new QR login session (no auth required)
    app.post('/qr', async (c) => {
        cleanupExpired()

        const id = randomUUID()
        const secret = randomBytes(24).toString('base64url')

        const session: QrSession = {
            id,
            secret,
            status: 'pending',
            createdAt: Date.now(),
        }
        qrSessions.set(id, session)

        return c.json({ id, secret })
    })

    // Poll QR login status (no auth required, needs secret)
    app.get('/qr/:id', async (c) => {
        cleanupExpired()

        const { id } = c.req.param()
        const secret = c.req.query('s')

        const session = qrSessions.get(id)
        if (!session) {
            return c.json({ status: 'expired' })
        }

        if (Date.now() - session.createdAt > QR_SESSION_TTL_MS) {
            qrSessions.delete(id)
            return c.json({ status: 'expired' })
        }

        if (!secret || secret !== session.secret) {
            return c.json({ error: 'Invalid secret' }, 403)
        }

        if (session.status === 'confirmed' && session.accessToken) {
            // One-time: delete after delivering
            qrSessions.delete(id)
            c.header('Cache-Control', 'no-store')
            return c.json({
                status: 'confirmed',
                accessToken: session.accessToken,
            })
        }

        c.header('Cache-Control', 'no-store')
        return c.json({ status: 'pending' })
    })

    // Confirm QR login (requires auth - verified manually)
    app.post('/qr/:id/confirm', async (c) => {
        cleanupExpired()

        const { id } = c.req.param()
        const secret = c.req.query('s')

        // Manually verify JWT since this route is before auth middleware
        const authorization = c.req.header('authorization')
        const tokenStr = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        if (!tokenStr) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        const confirmer = await authService.verifyJwt(tokenStr)
        if (!confirmer) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        const session = qrSessions.get(id)
        if (!session) {
            return c.json({ error: 'Session not found or expired' }, 404)
        }

        if (Date.now() - session.createdAt > QR_SESSION_TTL_MS) {
            qrSessions.delete(id)
            return c.json({ error: 'Session expired' }, 410)
        }

        if (!secret || secret !== session.secret) {
            return c.json({ error: 'Invalid secret' }, 403)
        }

        if (session.status !== 'pending') {
            return c.json({ error: 'Session already confirmed' }, 409)
        }

        // Parse optional expiry from body
        const body = await c.req.json().catch(() => null) as { expiresIn?: string } | null
        const expiresInKey = body?.expiresIn ?? DEFAULT_EXPIRY
        const expiresInMs = EXPIRY_PRESETS[expiresInKey] ?? EXPIRY_PRESETS[DEFAULT_EXPIRY]!

        // Create an access token under the confirmer's API key
        const rawToken = generateApiKey()
        store.accessTokens.createToken({
            id: randomUUID(),
            apiKeyId: confirmer.apiKeyId,
            name: `QR Login (${new Date().toISOString().slice(0, 16)})`,
            tokenHash: hashApiKey(rawToken),
            tokenPrefix: extractKeyPrefix(rawToken),
            namespace: confirmer.namespace,
            permissions: confirmer.permissions,
            expiresAt: expiresInMs === 0 ? 0 : Date.now() + expiresInMs
        })

        const accessToken = confirmer.namespace === 'default'
            ? rawToken
            : `${rawToken}:${confirmer.namespace}`

        session.status = 'confirmed'
        session.accessToken = accessToken

        return c.json({ ok: true })
    })

    // Deny/cancel QR login session (requires auth)
    app.post('/qr/:id/deny', async (c) => {
        cleanupExpired()

        const { id } = c.req.param()
        const secret = c.req.query('s')

        // Manually verify JWT since this route is before auth middleware
        const authorization = c.req.header('authorization')
        const tokenStr = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        if (!tokenStr) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        const result = await authService.verifyJwt(tokenStr)
        if (!result) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        const session = qrSessions.get(id)
        if (!session) {
            // Already gone or never existed - that's fine for deny
            return c.json({ ok: true })
        }

        if (!secret || secret !== session.secret) {
            return c.json({ error: 'Invalid secret' }, 403)
        }

        // Delete the session immediately
        qrSessions.delete(id)

        return c.json({ ok: true })
    })

    return app
}
