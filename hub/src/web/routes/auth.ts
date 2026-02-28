import { Hono } from 'hono'
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

const authBodySchema = z.union([telegramAuthSchema, accessTokenAuthSchema])

export function createAuthRoutes(store: Store, authService: AuthService): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = authBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
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
            const nsKeys = store.apiKeys.listApiKeys().filter(
                k => k.namespace === namespace && !k.revokedAt
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
