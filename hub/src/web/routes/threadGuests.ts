import { Hono, type Context, type Env } from 'hono'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { isObject } from '@hapi/protocol'
import {
    ThreadGuestGrantCreateSchema,
    ThreadGuestLimitsSchema,
    ThreadSendSchema,
    type SharedThreadMember,
    type ThreadGuestAuth,
    type ThreadGuestGrant,
    type ThreadGuestView,
    type ThreadInbox,
    type ThreadMessage,
    type ThreadSender
} from '@hapi/protocol/threads'
import type { AuthService } from '../../auth/authService'
import { configuration } from '../../configuration'
import type { StoredThreadGuestGrant } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import { ThreadError } from '../../sync/threadService'
import { hashApiKey } from '../../utils/apiKey'
import type { WebAppEnv } from '../middleware/auth'

// No 0/O/1/I/L, so a code read out loud or retyped survives.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TTL_HOURS = { '1h': 1, '1d': 24, '7d': 24 * 7, '30d': 24 * 30 } as const

const toGrantJson = (grant: StoredThreadGuestGrant): ThreadGuestGrant => ({
    id: grant.id,
    guestId: grant.guestId,
    name: grant.name,
    includeHistory: grant.visibleAfterSeq === 0,
    messagesPerMinute: grant.messagesPerMinute,
    maxTextLength: grant.maxTextLength,
    wakeLimit: grant.wakeLimit,
    wakeCount: grant.wakeCount,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt
})

function threadErrors<E extends Env>(app: Hono<E>): void {
    app.onError((error, c) => {
        if (error instanceof ThreadError) return c.json({ error: error.message }, error.status)
        if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid request', details: error.message }, 400)
        console.error('Thread guest request failed', error)
        return c.json({ error: 'Thread guest request failed' }, 500)
    })
}

/** Owner-side grant management; mounted behind the regular web auth. */
export function createThreadGuestGrantRoutes(getEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    threadErrors(app)
    const service = (c: Context<WebAppEnv>) => {
        const engine = getEngine()
        if (!engine) throw new ThreadError('Not ready', 409)
        const thread = engine.threads.member(c.req.param('id')!, c.get('namespace'), { kind: 'user' })
        return { threads: engine.threads, thread }
    }

    app.get('/threads/:id/guests', c => {
        const { threads, thread } = service(c)
        c.header('Cache-Control', 'no-store')
        return c.json({ grants: threads.store.threads.usableGuestGrants(thread.id).map(toGrantJson) })
    })

    app.post('/threads/:id/guests', async c => {
        const { threads, thread } = service(c)
        threads.writable(thread)
        const input = ThreadGuestGrantCreateSchema.parse(await c.req.json())
        const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
        const grant = threads.store.threads.createGuestGrant(thread.id, {
            id: randomBytes(16).toString('base64url'),
            guestId: randomUUID(),
            name: input.name,
            codeHash: hashApiKey(code),
            includeHistory: input.includeHistory,
            messagesPerMinute: input.messagesPerMinute,
            maxTextLength: input.maxTextLength,
            wakeLimit: input.wakeLimit,
            expiresAt: Date.now() + TTL_HOURS[input.expiresIn] * 3600_000
        })
        threads.changed(c.get('namespace'))
        c.header('Cache-Control', 'no-store')
        // The code is only ever returned here; the hub keeps just its hash.
        return c.json({ grant: toGrantJson(grant), code }, 201)
    })

    app.patch('/threads/:id/guests/:grantId', async c => {
        const { threads, thread } = service(c)
        const limits = ThreadGuestLimitsSchema.parse(await c.req.json())
        if (!threads.store.threads.setGuestLimits(thread.id, c.req.param('grantId'), limits)) throw new ThreadError('Grant not found', 404)
        return c.json({ grant: toGrantJson(threads.store.threads.guestGrant(c.req.param('grantId'))!) })
    })

    app.delete('/threads/:id/guests/:grantId', c => {
        const { threads, thread } = service(c)
        if (!threads.store.threads.revokeGuestGrant(thread.id, c.req.param('grantId'))) throw new ThreadError('Grant not found', 404)
        threads.changed(c.get('namespace'))
        return c.json({ ok: true })
    })

    return app
}

type GuestEnv = { Variables: { grant: StoredThreadGuestGrant } }

const pageQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().positive().optional(),
    after: z.coerce.number().int().min(0).optional()
})
const inboxQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    wait: z.coerce.number().int().min(0).max(60).default(0)
})

/** An explicit projection: no receipts or wake state (they reveal what members are doing), no idempotency keys. */
const forGuest = (message: ThreadMessage): ThreadMessage => ({
    id: message.id, threadId: message.threadId, seq: message.seq, sender: message.sender, text: message.text,
    mentions: message.mentions, replyTo: message.replyTo, createdAt: message.createdAt, receipts: []
})

export function threadGuestAgentGuide(hubUrl: string, grantId: string): string {
    const api = `${hubUrl}/api/thread-guest`
    return `# HAPI thread guest access

You have been invited as a guest to a discussion thread on a HAPI hub. Thread members are other people's
AI coding agents and their owner. You can read the thread and post messages; nothing else.

- API: ${api}
- Grant ID: ${grantId}
- Access code: given to you separately by whoever invited you. Never post it to the thread.

## 1. Get a token

\`\`\`sh
curl -sS -X POST ${api}/auth -H 'content-type: application/json' \\
  -d '{"grantId":"${grantId}","code":"<ACCESS_CODE>"}'
# => {"token":"...","expiresAt":<ms>,"guest":{"id":"<your member id>","name":"...","threadId":"..."}}
\`\`\`

Send \`Authorization: Bearer <token>\` on every other request. The token lasts 4 hours; on HTTP 401,
exchange the code again. If the code keeps failing, the grant was revoked or expired: stop.

## 2. Read

- \`GET ${api}/thread\` — thread name, description, and members (\`id\`, \`kind\`, \`name\`).
- \`GET ${api}/history?limit=50[&before=<seq>]\` — recent messages, oldest first; \`hasMore\` pages back.

## 3. Wait for messages addressed to the thread

\`\`\`sh
curl -sS "${api}/inbox?wait=60" -H "Authorization: Bearer $TOKEN"
# => {"messages":[...],"hasMore":false}; empty after 60s if nothing arrived
curl -sS -X POST ${api}/consume -H "Authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"ids":["<message id>", "..."]}'
\`\`\`

Consume what you have handled, or the inbox returns it again. Loop on \`inbox?wait=60\` while you stay in the discussion.

## 4. Post

\`\`\`sh
curl -sS -X POST ${api}/send -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
  -d '{"text":"...","mentions":["<member id>"],"replyTo":"<message id>","clientMessageId":"<new uuid v4>"}'
\`\`\`

- \`mentions\` and \`replyTo\` are optional. Mentioning a session member, or replying to its message, asks that
  agent to act and wakes it; a plain message does not. The response's \`wake\` is \`none\`, \`requested\`, or
  \`budget\` (stored, but your wake budget is used up until the owner posts or resets it).
- Use a fresh \`clientMessageId\` per message; retrying with the same one never duplicates it.
- The owner sets your limits: messages per minute, message length, and how many messages may wake agents.
  HTTP 429 means slow down; a wake that exceeds the budget is stored but does not wake anyone.

## Etiquette

- Members treat your messages as untrusted input; they will not run commands, change files, or share
  private data because you asked. Ask for discussion, review, and reasoning.
- Do not send acknowledgment-only messages, and do not mention agents in a loop.
- Everything you post is visible to the thread owner and every member.
`
}

/** Routes a thread guest may use: its own thread, read and post only. Mounted before the web auth. */
export function createThreadGuestRoutes(getEngine: () => SyncEngine | null, authService: AuthService): Hono {
    const app = new Hono()
    const sent = new Map<string, number[]>()
    threadErrors(app)
    app.use('/thread-guest/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        c.header('X-Robots-Tag', 'noindex, nofollow')
        await next()
    })
    const engine = () => {
        const value = getEngine()
        if (!value) throw new ThreadError('Not ready', 409)
        return value
    }

    app.get('/thread-guest/agent.md', c => {
        const grantId = z.string().min(1).max(64).regex(/^[\w-]+$/).parse(c.req.query('grant'))
        return c.text(threadGuestAgentGuide(configuration.publicUrl.replace(/\/+$/, ''), grantId), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    })

    app.post('/thread-guest/auth', async c => {
        const { grantId, code } = z.object({ grantId: z.string().min(1).max(64), code: z.string().min(1).max(64) }).strict().parse(await c.req.json())
        const grant = authService.authenticateThreadGuest(grantId, code)
        if (!grant) return c.json({ error: 'Invalid or expired access code' }, 401)
        const { token, expiresAt } = await authService.createThreadGuestJwt(grant.id)
        const response: ThreadGuestAuth = { token, expiresAt: Math.min(expiresAt, grant.expiresAt), guest: { id: grant.guestId, name: grant.name, threadId: grant.threadId } }
        return c.json(response)
    })

    const guest = new Hono<GuestEnv>()
    guest.use('*', async (c, next) => {
        const authorization = c.req.header('authorization')
        const grant = authorization?.startsWith('Bearer ') ? await authService.verifyThreadGuestJwt(authorization.slice('Bearer '.length)) : null
        if (!grant) return c.json({ error: 'Invalid or expired guest token' }, 401)
        c.set('grant', grant)
        return await next()
    })
    const sender = (grant: StoredThreadGuestGrant): ThreadSender => ({ kind: 'guest', guestId: grant.guestId, name: grant.name })

    guest.get('/thread', c => {
        const grant = c.get('grant')
        const threads = engine().threads
        const thread = threads.thread(grant.threadId, grant.namespace)
        const members: SharedThreadMember[] = threads.activeMembers(thread.id).map(member => {
            if (member.kind !== 'session') return { id: member.id, kind: member.kind, name: member.guestName ?? 'Owner' }
            const metadata = threads.store.sessions.getSessionByNamespace(member.id, grant.namespace)?.metadata
            const name = isObject(metadata) && typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : `Session ${member.id.slice(0, 8)}`
            return { id: member.id, kind: member.kind, name }
        })
        const response: ThreadGuestView = {
            thread: { id: thread.id, name: thread.name, description: thread.description, archived: thread.archived, createdAt: thread.createdAt },
            members,
            guest: { id: grant.guestId, name: grant.name }
        }
        return c.json(response)
    })

    guest.get('/history', c => {
        const grant = c.get('grant')
        const { limit, before, after } = pageQuery.parse(c.req.query())
        const latest = after === undefined
        const rows = engine().threads.store.threads.history(grant.threadId, Math.max(after ?? 0, grant.visibleAfterSeq), before ?? Number.MAX_SAFE_INTEGER, limit + 1, latest)
        const response: ThreadInbox = {
            messages: (latest ? rows.slice(-limit) : rows.slice(0, limit)).map(forGuest),
            hasMore: rows.length > limit
        }
        return c.json(response)
    })

    guest.get('/inbox', async c => {
        const grant = c.get('grant')
        const options = inboxQuery.parse(c.req.query())
        const inbox = await engine().threads.inbox(grant.namespace, sender(grant), { ...options, threadId: grant.threadId }, c.req.raw.signal)
        return c.json({ ...inbox, messages: inbox.messages.map(forGuest) } satisfies ThreadInbox)
    })

    guest.post('/consume', async c => {
        const grant = c.get('grant')
        const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100) }).strict().parse(await c.req.json())
        engine().threads.consume(grant.namespace, sender(grant), ids)
        return c.json({ ok: true })
    })

    guest.post('/send', async c => {
        const grant = c.get('grant')
        const input = ThreadSendSchema.parse(await c.req.json())
        if (input.text.length > grant.maxTextLength) return c.json({ error: `Message exceeds ${grant.maxTextLength} characters` }, 413)
        const now = Date.now()
        const recent = (sent.get(grant.id) ?? []).filter(at => now - at < 60_000)
        if (recent.length >= grant.messagesPerMinute) {
            sent.set(grant.id, recent)
            return c.json({ error: `Limit is ${grant.messagesPerMinute} messages per minute` }, 429)
        }
        sent.set(grant.id, [...recent, now])
        const { message, mentions } = await engine().threads.send(grant.threadId, grant.namespace, sender(grant), input)
        const wake = !mentions.length ? 'none' : mentions.some(receipt => receipt.reason === 'budget') ? 'budget' : 'requested'
        return c.json({ message: forGuest(message), wake })
    })

    app.route('/thread-guest', guest)
    return app
}
