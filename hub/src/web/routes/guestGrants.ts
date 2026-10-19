import { Hono } from 'hono'
import { randomBytes, randomInt } from 'node:crypto'
import { z } from 'zod'
import type { Store, StoredSessionGrant } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import { hashApiKey } from '../../utils/apiKey'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

// No 0/O/1/I/L, so a code read out loud or retyped survives.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const TTL_HOURS = { '1h': 1, '1d': 24, '7d': 24 * 7, '30d': 24 * 30 } as const

const createGrantSchema = z.object({
    expiresIn: z.enum(['1h', '1d', '7d', '30d']).default('1d'),
    description: z.string().trim().max(200).optional(),
    allowVoice: z.boolean().default(false)
})

const updateGrantSchema = z.object({
    allowVoice: z.boolean()
})

function generateCode(): string {
    return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
}

function toGrantJson(grant: StoredSessionGrant) {
    return {
        id: grant.id,
        description: grant.description,
        allowVoice: grant.allowVoice,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt
    }
}

export function createGuestGrantRoutes(getSyncEngine: () => SyncEngine | null, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/guest-grants', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const grants = store.sessionGrants.listUsableBySession(sessionResult.sessionId, c.get('namespace'))
        return c.json({ grants: grants.map(toGrantJson) })
    })

    app.post('/sessions/:id/guest-grants', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const parsed = createGrantSchema.safeParse(await c.req.json().catch(() => ({})))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const code = generateCode()
        const grant = store.sessionGrants.create({
            id: randomBytes(16).toString('base64url'),
            sessionId: sessionResult.sessionId,
            namespace: c.get('namespace'),
            codeHash: hashApiKey(code),
            description: parsed.data.description || null,
            allowVoice: parsed.data.allowVoice,
            expiresAt: Date.now() + TTL_HOURS[parsed.data.expiresIn] * 3600_000
        })
        // The code is only ever returned here; the hub keeps just its hash.
        return c.json({ grant: toGrantJson(grant), code }, 201)
    })

    app.patch('/sessions/:id/guest-grants/:grantId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const parsed = updateGrantSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const grant = store.sessionGrants.setAllowVoice(
            c.req.param('grantId'),
            sessionResult.sessionId,
            c.get('namespace'),
            parsed.data.allowVoice
        )
        if (!grant) {
            return c.json({ error: 'Grant not found' }, 404)
        }
        return c.json({ grant: toGrantJson(grant) })
    })

    app.delete('/sessions/:id/guest-grants/:grantId', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const ok = store.sessionGrants.revoke(c.req.param('grantId'), sessionResult.sessionId, c.get('namespace'))
        if (!ok) {
            return c.json({ error: 'Grant not found' }, 404)
        }
        return c.json({ ok: true })
    })

    return app
}
