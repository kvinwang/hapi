import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import type { AuthService } from '../../auth/authService'

const bindBodySchema = z.object({
    initData: z.string(),
    accessToken: z.string()
})

export function createBindRoutes(store: Store, authService: AuthService): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/bind', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = bindBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const auth = authService.authenticateCliToken(parsed.data.accessToken)
        if (!auth) {
            return c.json({ error: 'Invalid access token' }, 401)
        }
        const namespace = auth.namespace

        if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
            return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
        }

        const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
        if (!result.ok) {
            return c.json({ error: result.error }, 401)
        }

        const telegramUserId = String(result.user.id)
        const existingUser = store.users.getUser('telegram', telegramUserId)
        if (existingUser && existingUser.namespace !== namespace) {
            return c.json({ error: 'already_bound' }, 409)
        }
        store.users.addUser('telegram', telegramUserId, namespace)

        const userId = await getOrCreateOwnerId()

        const token = await authService.createJwt({
            apiKeyId: auth.apiKeyId,
            userId,
            namespace,
            permissions: auth.permissions
        })

        return c.json({
            token,
            user: {
                id: userId,
                username: result.user.username,
                firstName: result.user.first_name,
                lastName: result.user.last_name
            }
        })
    })

    return app
}
