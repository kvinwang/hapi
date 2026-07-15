import { Hono } from 'hono'
import { join, extname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { AuthService } from '../../auth/authService'
import { hasPermission } from '../../auth/permissions'
import type { Permission } from '../../store/types'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import type { DecryptedMessage, SyncEvent } from '@hapi/protocol/types'
import { isObject } from '@hapi/protocol'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const createOrLoadSessionSchema = z.object({
    tag: z.string().min(1),
    parentSessionId: z.string().uuid().nullable().optional(),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional()
})

const sendMessageSchema = z.object({
    text: z.string().min(1),
    wait: z.boolean().optional()
})

const createOrLoadMachineSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    runnerState: z.unknown().nullable().optional()
})

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

const getHistoryQuerySchema = z.object({
    tail: z.coerce.number().int().min(1).max(200).optional(),
    search: z.string().trim().min(1).optional(),
    role: z.enum(['user', 'assistant', 'tool']).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    snippet: z.string().optional()
})

function parseBooleanQuery(value: string | undefined): boolean {
    if (!value) {
        return false
    }
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

type CliEnv = {
    Variables: {
        namespace: string
        permissions: Permission[]
        apiKeyId: string
    }
}

function resolveSessionForNamespace(
    engine: SyncEngine,
    sessionId: string,
    namespace: string
): { ok: true; session: Session; sessionId: string } | { ok: false; status: 403 | 404; error: string } {
    const access = engine.resolveSessionAccess(sessionId, namespace)
    if (access.ok) {
        return { ok: true, session: access.session, sessionId: access.sessionId }
    }
    return {
        ok: false,
        status: access.reason === 'access-denied' ? 403 : 404,
        error: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found'
    }
}

function resolveMachineForNamespace(
    engine: SyncEngine,
    machineId: string,
    namespace: string
): { ok: true; machine: Machine } | { ok: false; status: 403 | 404; error: string } {
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (machine) {
        return { ok: true, machine }
    }
    if (engine.getMachine(machineId)) {
        return { ok: false, status: 403, error: 'Machine access denied' }
    }
    return { ok: false, status: 404, error: 'Machine not found' }
}

const MAX_FILE_BYTES = 50 * 1024 * 1024

const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

const uploadFileSchema = z.object({
    content: z.string().min(1),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127).optional(),
})

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

export function createCliRoutes(getSyncEngine: () => SyncEngine | null, authService: AuthService, filesDir?: string): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    app.use('*', async (c, next) => {
        c.header('X-Hapi-Protocol-Version', String(PROTOCOL_VERSION))

        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }

        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }

        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const auth = authService.authenticateCliToken(token)
        if (!auth) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', auth.namespace)
        c.set('permissions', auth.permissions)
        c.set('apiKeyId', auth.apiKeyId)
        return await next()
    })

    app.post('/sessions', async (c) => {
        if (!hasPermission(c.get('permissions'), 'sessions:write')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadSessionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        if (parsed.data.parentSessionId) {
            const parent = resolveSessionForNamespace(engine, parsed.data.parentSessionId, namespace)
            if (!parent.ok) {
                return c.json({
                    error: parent.status === 403 ? 'Parent session access denied' : 'Parent session not found'
                }, parent.status)
            }
        }
        const session = engine.getOrCreateSession(
            parsed.data.tag,
            parsed.data.metadata,
            parsed.data.agentState ?? null,
            namespace,
            parsed.data.parentSessionId ?? null
        )
        return c.json({ session })
    })

    app.get('/sessions/:id', (c) => {
        if (!hasPermission(c.get('permissions'), 'sessions:read')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', (c) => {
        if (!hasPermission(c.get('permissions'), 'sessions:read')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? 200
        const messages = engine.getMessagesAfter(resolved.sessionId, { afterSeq: parsed.data.afterSeq, limit })
        return c.json({ messages })
    })

    app.get('/sessions/:id/history', (c) => {
        if (!hasPermission(c.get('permissions'), 'sessions:read')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getHistoryQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? parsed.data.tail ?? 20
        const history = engine.getSessionHistory(resolved.sessionId, {
            tail: parsed.data.tail,
            search: parsed.data.search,
            role: parsed.data.role,
            afterSeq: parsed.data.afterSeq,
            beforeSeq: parsed.data.beforeSeq,
            limit,
            snippet: parseBooleanQuery(parsed.data.snippet)
        })
        return c.json(history)
    })

    // Full conversation export — same JSON body as public `/shared/:token?fmt=json`.
    app.get('/sessions/:id/export', (c) => {
        if (!hasPermission(c.get('permissions'), 'sessions:read')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const exported = engine.exportSessionShareJson(resolved.sessionId)
        if (!exported) {
            return c.json({ error: 'Session not found' }, 404)
        }
        return c.json(exported)
    })

    app.get('/machines', (c) => {
        if (!hasPermission(c.get('permissions'), 'machines:read')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = engine.getMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.post('/machines', async (c) => {
        if (!hasPermission(c.get('permissions'), 'machines:write')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadMachineSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const apiKeyId = c.get('apiKeyId')
        const existing = engine.getMachine(parsed.data.id)
        if (existing) {
            if (existing.namespace !== namespace) {
                return c.json({ error: 'Machine access denied' }, 403)
            }
            if (existing.apiKeyId && existing.apiKeyId !== apiKeyId) {
                if (!hasPermission(c.get('permissions'), 'machines:manage')) {
                    return c.json({ error: 'Machine is bound to a different API key' }, 403)
                }
            }
        } else {
            // New machine — reject if another machine in the same namespace has the same displayName
            const meta = parsed.data.metadata as { displayName?: string } | null
            const displayName = meta?.displayName
            if (displayName) {
                const nsMachines = engine.getMachinesByNamespace(namespace)
                const duplicate = nsMachines.find((m) => m.metadata?.displayName === displayName)
                if (duplicate) {
                    return c.json({ error: `A machine with displayName "${displayName}" already exists (${duplicate.id})` }, 409)
                }
            }
        }
        const machine = engine.getOrCreateMachine(parsed.data.id, parsed.data.metadata, parsed.data.runnerState ?? null, namespace, apiKeyId)
        return c.json({ machine })
    })

    app.get('/machines/:id', (c) => {
        if (!hasPermission(c.get('permissions'), 'machines:read')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ machine: resolved.machine })
    })

    app.patch('/machines/:id/notes', async (c) => {
        if (!hasPermission(c.get('permissions'), 'machines:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = z.object({ notes: z.string().nullable() }).safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const updated = engine.updateMachineNotes(machineId, parsed.data.notes)
        if (!updated) {
            return c.json({ error: 'Failed to update notes' }, 500)
        }
        return c.json({ ok: true, notes: updated.notes })
    })

    const importSshKeySchema = z.object({
        publicKey: z.string().min(1)
    })

    app.post('/machines/:id/import-ssh-key', async (c) => {
        const permissions = c.get('permissions')
        if (!hasPermission(permissions, 'machines:ssh:manage')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = importSshKeySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.importSshKey(machineId, parsed.data.publicKey)
            if (!result.success) {
                return c.json({ error: result.error ?? 'Failed to import SSH key' }, 500)
            }
            return c.json(result)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to import SSH key'
            }, 500)
        }
    })

    if (filesDir) {
        app.post('/files', async (c) => {
            if (!hasPermission(c.get('permissions'), 'sessions:write')) {
                return c.json({ error: 'Insufficient permissions' }, 403)
            }
            const json = await c.req.json().catch(() => null)
            const parsed = uploadFileSchema.safeParse(json)
            if (!parsed.success) {
                return c.json({ error: 'Invalid body' }, 400)
            }

            const { content, sessionId, filename, mimeType } = parsed.data
            const ext = extname(filename).replace(/^\./, '').toLowerCase()
            if (ext && !/^\w{1,10}$/.test(ext)) {
                return c.json({ error: 'Invalid file extension' }, 400)
            }

            // Validate session exists and belongs to caller's namespace
            const engine = getSyncEngine()
            if (!engine) {
                return c.json({ error: 'Not ready' }, 503)
            }
            const resolved = resolveSessionForNamespace(engine, sessionId, c.get('namespace'))
            if (!resolved.ok) {
                return c.json({ error: resolved.error }, resolved.status)
            }

            const estimatedBytes = estimateBase64Bytes(content)
            if (estimatedBytes > MAX_FILE_BYTES) {
                return c.json({ error: 'File too large (max 50MB)' }, 400)
            }

            try {
                const buffer = Buffer.from(content, 'base64')
                if (buffer.length > MAX_FILE_BYTES) {
                    return c.json({ error: 'File too large (max 50MB)' }, 400)
                }

                const id = randomUUID()
                const fileId = ext ? `${id}.${ext}` : id
                const sessionDir = join(filesDir, sessionId)
                mkdirSync(sessionDir, { recursive: true })
                await Bun.write(join(sessionDir, fileId), buffer)

                // Write metadata file
                const meta: Record<string, string> = { filename }
                if (mimeType) meta.mimeType = mimeType
                await Bun.write(join(sessionDir, `${fileId}.meta.json`), JSON.stringify(meta))

                const url = `/api/files/${sessionId}/${fileId}`
                return c.json({ id, url })
            } catch (error) {
                return c.json({
                    error: error instanceof Error ? error.message : 'Failed to upload file'
                }, 500)
            }
        })
    }

    app.post('/sessions/:id/send', async (c) => {
        if (!hasPermission(c.get('permissions'), 'sessions:write')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        if (!resolved.session.active) {
            return c.json({ error: 'Session is not active' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = sendMessageSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: text is required' }, 400)
        }

        const { seq: userMsgSeq } = await engine.sendMessage(resolved.sessionId, {
            text: parsed.data.text,
            sentFrom: 'cli'
        })

        if (!parsed.data.wait) {
            return c.json({ ok: true, seq: userMsgSeq })
        }

        // Wait for assistant reply: subscribe to events, collect text until session stops thinking
        const replyTexts = await waitForAssistantReply(engine, resolved.sessionId)
        return c.json({ ok: true, seq: userMsgSeq, reply: replyTexts.join('\n') })
    })

    // Extract only text blocks from assistant-type agent outputs.
    // Skips tool_use, tool_result, and other non-text content.
    function extractAssistantTexts(messages: DecryptedMessage[]): string[] {
        const texts: string[] = []
        for (const msg of messages) {
            const content = msg.content
            if (!isObject(content) || content.role !== 'agent') continue
            const inner = isObject(content.content) ? content.content : null
            if (!inner || inner.type !== 'output') continue
            const data = isObject(inner.data) ? inner.data : null
            if (!data || data.type !== 'assistant') continue
            // data.message.content is the Claude API response content array
            const apiMsg = isObject(data.message) ? data.message : null
            const blocks = Array.isArray(apiMsg?.content) ? apiMsg.content : []
            for (const block of blocks) {
                if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
                    const trimmed = block.text.trim()
                    if (trimmed.length > 0) {
                        texts.push(trimmed)
                    }
                }
            }
        }
        return texts
    }

    // Wait for the NEXT complete thinking cycle after our message is queued.
    // State machine:
    //   wait-idle: session was busy, wait for current turn to finish
    //   wait-thinking: session is idle, wait for it to pick up our message (thinking=true)
    //   wait-done: session is processing our batch, wait for it to finish (thinking=false)
    // anchorSeq is captured at the wait-idle → wait-thinking transition,
    // so only messages produced AFTER the previous turn are collected.
    function waitForAssistantReply(engine: SyncEngine, sessionId: string): Promise<string[]> {
        const timeout = 10 * 60 * 1000
        type Phase = 'wait-idle' | 'wait-thinking' | 'wait-done'

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsubscribe()
                reject(new Error('Timeout waiting for reply'))
            }, timeout)

            const session = engine.getSession(sessionId)
            let phase: Phase = session?.thinking ? 'wait-idle' : 'wait-thinking'
            // Anchor: latest message seq when previous turn finishes
            let anchorSeq = !session?.thinking ? engine.getLatestMessageSeq(sessionId) : 0

            const onUpdate = () => {
                const s = engine.getSession(sessionId)
                if (!s) return

                if (phase === 'wait-idle') {
                    if (!s.thinking) {
                        // Previous turn done — capture latest seq as anchor
                        anchorSeq = engine.getLatestMessageSeq(sessionId)
                        phase = 'wait-thinking'
                    }
                    return
                }

                if (phase === 'wait-thinking') {
                    if (s.thinking) {
                        phase = 'wait-done'
                    }
                    return
                }

                // wait-done: our batch is being processed, wait for finish
                if (s.thinking) return

                const messages = engine.getMessagesAfter(sessionId, { afterSeq: anchorSeq, limit: 500 })
                const texts = extractAssistantTexts(messages)
                if (texts.length > 0) {
                    clearTimeout(timer)
                    unsubscribe()
                    resolve(texts)
                }
            }

            const unsubscribe = engine.subscribe((event: SyncEvent) => {
                if (event.type === 'session-updated' && event.sessionId === sessionId) {
                    onUpdate()
                }
            })
        })
    }

    return app
}
