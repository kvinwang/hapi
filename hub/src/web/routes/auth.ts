import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { AuthService } from '../../auth/authService'
import type { Permission } from '../../store/types'

const telegramAuthSchema = z.object({
    initData: z.string()
})

const accessTokenAuthSchema = z.object({
    accessToken: z.string()
})

const guestAuthSchema = z.object({
    guestGrantId: z.string().min(1).max(64),
    code: z.string().min(1).max(64)
})

const authBodySchema = z.union([telegramAuthSchema, accessTokenAuthSchema, guestAuthSchema])

const cookieOptions = () => ({
    httpOnly: true,
    secure: configuration.publicUrl.startsWith('https://'),
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: 4 * 3600,
})

export function createAuthRoutes(store: Store, authService: AuthService): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = authBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        if ('guestGrantId' in parsed.data) {
            const guest = authService.authenticateGuest(parsed.data.guestGrantId, parsed.data.code)
            if (!guest) {
                return c.json({ error: 'Invalid or expired access code' }, 401)
            }
            const token = await authService.createGuestJwt(guest.grantId)
            // Its own cookie, so a guest login never replaces an owner's `hapi_token`.
            setCookie(c, 'hapi_guest', token, cookieOptions())
            const voiceEnabled = guest.allowVoice && store.preferences.get(guest.namespace, 'dashscopeApiKey') !== null
            return c.json({
                token,
                user: { id: 0, firstName: 'Guest' },
                guest: { sessionId: guest.sessionId, voiceEnabled }
            })
        }

        let userId: number
        let username: string | undefined
        let firstName: string | undefined
        let lastName: string | undefined
        let namespace: string
        let apiKeyId: string
        let accessTokenId: string | null = null
        let permissions: Permission[]

        // Access Token authentication (API key or legacy CLI_API_TOKEN)
        if ('accessToken' in parsed.data) {
            const auth = authService.authenticateCliToken(parsed.data.accessToken)
            if (!auth) {
                return c.json({ error: 'Invalid access token' }, 401)
            }
            userId = await getOrCreateOwnerId()
            firstName = 'Web User'
            namespace = auth.namespace
            apiKeyId = auth.apiKeyId
            accessTokenId = auth.accessTokenId
            permissions = auth.permissions
        } else {
            if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
                return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
            }

            // Telegram initData authentication
            const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
            if (!result.ok) {
                return c.json({ error: result.error }, 401)
            }

            const telegramUserId = String(result.user.id)
            const storedUser = store.users.getUser('telegram', telegramUserId)
            if (!storedUser) {
                return c.json({ error: 'not_bound' }, 401)
            }

            userId = await getOrCreateOwnerId()
            username = result.user.username
            firstName = result.user.first_name
            lastName = result.user.last_name
            namespace = storedUser.namespace
            // Telegram users are the account owner — always full access
            const nsKeys = store.apiKeys.listApiKeys(namespace).filter(
                k => !k.revokedAt
            )
            apiKeyId = nsKeys.length > 0 ? nsKeys[0].id : '__telegram__'
            permissions = ['admin'] as Permission[]
        }

        const token = await authService.createJwt({
            apiKeyId,
            accessTokenId,
            userId,
            namespace,
            permissions
        })

        setCookie(c, 'hapi_token', token, cookieOptions())

        return c.json({
            token,
            user: {
                id: userId,
                username,
                firstName,
                lastName
            }
        })
    })

    return app
}
