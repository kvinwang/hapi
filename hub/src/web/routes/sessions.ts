import {
    getPermissionModesForFlavor,
    isEffortModeAllowedForFlavor,
    isModelModeAllowedForFlavor,
    isPermissionModeAllowedForFlavor,
    toSessionSummary
} from '@hapi/protocol'
import { ModelModeSchema, PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'
import { hasPermission } from '../../auth/permissions'
import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

const sessionCostCache = new Map<string, { seq: number; model: string; pricingUpdatedAt: number; cost?: number }>()

function sessionTotalCost(store: Store, session: Session, namespace: string): number | undefined {
    const model = session.metadata?.resolvedModel
    if (typeof model !== 'string') return undefined
    const pricing = store.modelPricing.get(namespace, model)
    if (!pricing) return undefined
    const cachedCost = sessionCostCache.get(session.id)
    if (cachedCost?.seq === session.seq && cachedCost.model === model && cachedCost.pricingUpdatedAt === pricing.updatedAt) {
        return cachedCost.cost
    }

    let input = 0
    let output = 0
    let cached = 0
    let codexTotals: { input: number; output: number; cached: number } | null = null
    const usageIds = new Set<string>()
    for (const message of store.messages.getMessages(session.id, Math.max(200, session.seq + 1))) {
        const record = unwrapRoleWrappedRecordEnvelope(message.content)
        if (!record || record.role !== 'agent' || !isObject(record.content)) continue
        const content = record.content
        const data = isObject(content.data) ? content.data : null
        if (!data) continue
        if (content.type === 'output' && data.type === 'assistant' && isObject(data.message) && isObject(data.message.usage)) {
            const usage = data.message.usage
            const usageId = typeof data.message.id === 'string' ? data.message.id : null
            if (usageId && usageIds.has(usageId)) continue
            if (usageId) usageIds.add(usageId)
            input += Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)
            output += Number(usage.output_tokens ?? 0)
            cached += Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)
        } else if (content.type === 'codex' && data.type === 'token_count') {
            const info = isObject(data.info) ? data.info : data
            const total = isObject(info.total) ? info.total : isObject(info.total_token_usage) ? info.total_token_usage : null
            if (!total) continue
            codexTotals = {
                input: Number(total.input_tokens ?? total.inputTokens ?? total.total_input_tokens ?? 0),
                output: Number(total.output_tokens ?? total.outputTokens ?? total.total_output_tokens ?? 0),
                cached: Number(total.cached_input_tokens ?? total.cachedInputTokens ?? total.cache_read_input_tokens ?? 0)
            }
        }
    }
    if (codexTotals) ({ input, output, cached } = codexTotals)
    const cost = input === 0 && output === 0 ? undefined : Math.max(0, input - cached) * pricing.inputPerMillion / 1_000_000
        + cached * pricing.cachedInputPerMillion / 1_000_000
        + output * pricing.outputPerMillion / 1_000_000
    sessionCostCache.set(session.id, { seq: session.seq, model, pricingUpdatedAt: pricing.updatedAt, cost })
    return cost
}

const permissionModeSchema = z.object({
    mode: PermissionModeSchema
})

const modelModeSchema = z.object({
    model: ModelModeSchema
})

const codexGoalSchema = z.object({
    objective: z.string().trim().min(1).max(10000).optional(),
    status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']).optional(),
    tokenBudget: z.number().int().positive().nullable().optional()
}).refine((value) => Object.keys(value).length > 0)

const renameSessionSchema = z.object({
    name: z.string().min(1).max(255)
})

const reparentSessionSchema = z.object({
    parentSessionId: z.string().nullable()
})

const deleteModeSchema = z.enum(['single', 'detach-children', 'recursive'])

const convertSessionSchema = z.object({
    targetAgent: z.enum(['claude', 'codex'])
})

const uploadSchema = z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    mimeType: z.string().min(1).max(255)
})

const uploadDeleteSchema = z.object({
    path: z.string().min(1)
})

const sessionUiStateSchema = z.object({
    files: z.object({
        searchQuery: z.string().optional(),
        tab: z.enum(['changes', 'directories']).optional()
    }).optional(),
    terminal: z.object({
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional()
    }).optional(),
    pinned: z.boolean().optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    systemPrompt: z.string().max(10000).optional(),
    useGlobalPrompt: z.boolean().optional()
})

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

export function createSessionsRoutes(getSyncEngine: () => SyncEngine | null, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const getPendingCount = (s: Session) => s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0

        const namespace = c.get('namespace')
        const wantAll = c.req.query('all') === 'true'
        const permissions = c.get('permissions') ?? []
        if (wantAll && !hasPermission(permissions, 'sessions:read:all')) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const pinnedIds = store.sessions.getPinnedSessionIds(namespace)
        const tagsMap = store.sessions.getSessionTags(namespace)
        const inactiveCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
        const sessions = (wantAll ? engine.getSessions() : engine.getSessionsByNamespace(namespace))
            .filter((s) => s.active || s.updatedAt >= inactiveCutoff)
            .sort((a, b) => {
                // Active sessions first
                if (a.active !== b.active) {
                    return a.active ? -1 : 1
                }
                // Within active sessions, sort by pending requests count
                const aPending = getPendingCount(a)
                const bPending = getPendingCount(b)
                if (a.active && aPending !== bPending) {
                    return bPending - aPending
                }
                // Then by updatedAt
                return b.updatedAt - a.updatedAt
            })
            .map(s => {
                const summary = toSessionSummary(s)
                summary.totalCost = sessionTotalCost(store, s, s.namespace)
                if (pinnedIds.has(s.id)) summary.pinned = true
                const tags = tagsMap.get(s.id)
                if (tags) summary.tags = tags
                return summary
            })

        return c.json({ sessions })
    })

    app.get('/sessions/shared', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const namespace = c.get('namespace')
        const sessions = store.sessions.getSharedSessionsByNamespace(namespace)

        return c.json({
            sessions: sessions.map((s) => {
                const metadata = s.metadata as Record<string, unknown> | null
                const name = metadata?.name as string | undefined
                const summary = metadata?.summary as { text: string } | undefined
                const path = metadata?.path as string | undefined
                const flavor = metadata?.flavor as string | undefined

                let title = 'Shared Session'
                if (name) title = name
                else if (summary?.text) title = summary.text
                else if (path) {
                    const parts = path.split('/').filter(Boolean)
                    if (parts.length > 0) title = parts[parts.length - 1]
                }

                return {
                    id: s.id,
                    title,
                    flavor: flavor ?? null,
                    active: s.active,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt
                }
            })
        })
    })

    app.get('/sessions/:id', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        return c.json({ session: sessionResult.session })
    })

    app.get('/sessions/:id/debug-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        try {
            const debugState = await engine.getSessionDebugState(sessionResult.sessionId)
            return c.json(debugState)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to fetch session debug state'
            const status = message.includes('RPC handler not registered') ? 503 : 500
            return c.json({ success: false, error: message }, status)
        }
    })

    app.post('/sessions/:id/resume', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        const result = await engine.resumeSession(sessionResult.sessionId, namespace)
        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/sessions/:id/fork', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json<{ messageSeq: number }>()
        if (typeof body.messageSeq !== 'number' || !Number.isFinite(body.messageSeq)) {
            return c.json({ error: 'messageSeq is required and must be a number' }, 400)
        }

        const namespace = c.get('namespace')
        const result = await engine.forkSession(sessionResult.sessionId, body.messageSeq, namespace)
        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'fork_not_ready' ? 409
                            : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/sessions/:id/convert', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = convertSessionSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const result = await engine.convertSession(sessionResult.sessionId, parsed.data.targetAgent, namespace)
        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'already_target_flavor' ? 409
                            : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.get('/sessions/:id/ui-state', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        const state = engine.getSessionUiState(sessionResult.sessionId, namespace)
        return c.json({ state: state ?? {} })
    })

    app.post('/sessions/:id/ui-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = sessionUiStateSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const current = engine.getSessionUiState(sessionResult.sessionId, namespace)
        const currentObj = current && typeof current === 'object' ? current as Record<string, unknown> : {}
        const next = {
            ...currentObj,
            ...parsed.data
        }
        const ok = engine.updateSessionUiState(sessionResult.sessionId, namespace, next)
        if (!ok) {
            return c.json({ error: 'Failed to update session ui state' }, 500)
        }
        return c.json({ ok: true, state: next })
    })

    app.post('/sessions/:id/upload', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = uploadSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const estimatedBytes = estimateBase64Bytes(parsed.data.content)
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
            return c.json({ success: false, error: 'File too large (max 50MB)' }, 413)
        }

        try {
            const result = await engine.uploadFile(
                sessionResult.sessionId,
                parsed.data.filename,
                parsed.data.content,
                parsed.data.mimeType
            )
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to upload file'
            }, 500)
        }
    })

    app.post('/sessions/:id/upload/delete', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = uploadDeleteSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.deleteUploadFile(sessionResult.sessionId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete upload'
            }, 500)
        }
    })

    app.post('/sessions/:id/abort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        engine.forceSessionIdle(
            sessionResult.sessionId,
            {
                active: sessionResult.session.active ? true : undefined,
                time: Date.now()
            }
        )

        void engine.abortSession(sessionResult.sessionId).catch((error) => {
            console.warn('[sessions.abort] RPC abort failed; session state was reset locally', error)
        })

        return c.json({ ok: true })
    })

    app.post('/sessions/:id/interrupt', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.interruptSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/archive', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.archiveSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/switch', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.switchSession(sessionResult.sessionId, 'remote')
        return c.json({ ok: true })
    })

    app.get('/sessions/:id/codex-goal', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'codex') return c.json({ error: 'Codex session required' }, 400)
        try {
            return c.json(await engine.getCodexGoal(sessionResult.sessionId))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to read goal' }, 409)
        }
    })

    app.post('/sessions/:id/codex-goal', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'codex') return c.json({ error: 'Codex session required' }, 400)
        const parsed = codexGoalSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            return c.json(await engine.setCodexGoal(sessionResult.sessionId, parsed.data))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to update goal' }, 409)
        }
    })

    app.delete('/sessions/:id/codex-goal', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'codex') return c.json({ error: 'Codex session required' }, 400)
        try {
            return c.json(await engine.clearCodexGoal(sessionResult.sessionId))
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to clear goal' }, 409)
        }
    })

    app.post('/sessions/:id/permission-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = permissionModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        const mode = parsed.data.mode

        const allowedModes = getPermissionModesForFlavor(flavor)
        if (allowedModes.length === 0) {
            return c.json({ error: 'Permission mode not supported for session flavor' }, 400)
        }

        if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
            return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { permissionMode: mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply permission mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/model', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = modelModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!isModelModeAllowedForFlavor(parsed.data.model, flavor)) {
            return c.json({ error: 'Model mode is not supported for this session agent' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { modelMode: parsed.data.model })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/effort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const effortSchema = z.object({ effort: z.string().min(1) })
        const parsed = effortSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!isEffortModeAllowedForFlavor(parsed.data.effort, flavor)) {
            return c.json({ error: 'Effort mode is not supported for this session agent' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, {
                effortMode: parsed.data.effort as import('@hapi/protocol/types').EffortMode
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply effort mode'
            return c.json({ error: message }, 409)
        }
    })

    app.patch('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)

        // Try reparent (set parentSessionId to null or another session id)
        const reparentParsed = reparentSessionSchema.safeParse(body)
        if (reparentParsed.success) {
            try {
                engine.reparentSession(sessionResult.sessionId, reparentParsed.data.parentSessionId)
                return c.json({ ok: true })
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to reparent session'
                return c.json({ error: message }, 500)
            }
        }

        // Try rename
        const parsed = renameSessionSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.renameSession(sessionResult.sessionId, parsed.data.name)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to rename session'
            // Map concurrency/version errors to 409 conflict
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.delete('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        if (sessionResult.session.active) {
            return c.json({ error: 'Cannot delete active session. Archive it first.' }, 409)
        }

        const namespace = c.get('namespace')
        const storedSession = store.sessions.getSessionByNamespace(sessionResult.sessionId, namespace)
        if (storedSession?.shareToken) {
            return c.json({ error: 'Cannot delete shared session. Unshare it first.' }, 409)
        }

        const parsedMode = deleteModeSchema.safeParse(c.req.query('mode') ?? 'single')
        if (!parsedMode.success) {
            return c.json({ error: 'Invalid delete mode' }, 400)
        }

        try {
            await engine.deleteSession(sessionResult.sessionId, { mode: parsedMode.data })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to delete session'
            // Map "active session" or "shared session" errors to 409 conflict
            if (message.includes('active') || message.includes('shared') || message.includes('child')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.get('/sessions/:id/slash-commands', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Get agent type from session metadata, default to 'claude'
        const agent = sessionResult.session.metadata?.flavor ?? 'claude'

        try {
            const result = await engine.listSlashCommands(sessionResult.sessionId, agent)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list slash commands'
            })
        }
    })

    app.get('/sessions/:id/skills', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        try {
            const result = await engine.listSkills(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list skills'
            })
        }
    })

    app.post('/sessions/:id/share', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        // Use session ID as the share token (URL will be /share/<sessionId>)
        const ok = store.sessions.setShareToken(sessionResult.sessionId, namespace, sessionResult.sessionId)
        if (!ok) {
            return c.json({ error: 'Failed to create share link' }, 500)
        }

        return c.json({ shareToken: sessionResult.sessionId })
    })

    app.delete('/sessions/:id/share', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        store.sessions.setShareToken(sessionResult.sessionId, namespace, null)
        return c.json({ ok: true })
    })

    app.get('/sessions/:id/share', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        const session = store.sessions.getSessionByNamespace(sessionResult.sessionId, namespace)
        return c.json({ shareToken: session?.shareToken ?? null })
    })

    return app
}
