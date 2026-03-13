/**
 * Lobstear voice channel service for HAPI Hub.
 * Pure bridge mode: voice I/O for existing HAPI sessions.
 * Supports multiple devices, each with its own uplink connection.
 *
 * Routes (under /api/lobstear, auth handled by unified middleware):
 *   GET    /lobstear/down?deviceId=...    SSE stream (hub → relay)
 *   POST   /lobstear/up?deviceId=...      Messages from relay
 *   GET    /lobstear/devices              List devices with status
 *   POST   /lobstear/devices             Register new device
 *   PUT    /lobstear/devices/:id         Update name / bind session
 *   DELETE /lobstear/devices/:id         Unregister device
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { UplinkServer } from './uplinkServer'
import type { UplinkUp } from './uplinkProtocol'
import type { WebAppEnv } from '../web/middleware/auth'
import type { SyncEngine } from '../sync/syncEngine'
import type { SyncEvent } from '@hapi/protocol/types'
import type { LobstearDeviceStore } from '../store/lobstearDeviceStore'

interface DeviceContext {
    uplink: UplinkServer
    sessionId: string | null
    unsub: (() => void) | null
    /** Set on interrupt; suppresses outbound until next inbound */
    interrupted: boolean
}

export class LobstearService {
    private devices = new Map<string, DeviceContext>()

    constructor(
        private getSyncEngine: () => SyncEngine | null,
        readonly deviceStore: LobstearDeviceStore
    ) {
        // Restore bindings from DB
        for (const dev of deviceStore.listDevices()) {
            if (dev.bridgedSessionId) {
                const ctx = this.getOrCreateDevice(dev.id)
                this.bindDevice(ctx, dev.id, dev.bridgedSessionId)
            }
        }
    }

    getOrCreateDevice(deviceId: string): DeviceContext {
        let ctx = this.devices.get(deviceId)
        if (ctx) return ctx

        const uplink = new UplinkServer()
        ctx = { uplink, sessionId: null, unsub: null, interrupted: false }
        this.devices.set(deviceId, ctx)

        uplink.on('inbound', (text, _senderId) => {
            ctx!.interrupted = false // new turn resets interrupt
            void this.handleInbound(deviceId, ctx!, text)
        })

        uplink.on('interrupt', () => {
            console.log(`[Lobstear:${deviceId}] Interrupt — suppressing outbound`)
            ctx!.interrupted = true
        })

        return ctx
    }

    getDevice(deviceId: string): DeviceContext | undefined {
        return this.devices.get(deviceId)
    }

    private async handleInbound(deviceId: string, ctx: DeviceContext, text: string): Promise<void> {
        if (!ctx.sessionId) {
            console.log(`[Lobstear:${deviceId}] No session bound, ignoring inbound`)
            ctx.uplink.sendOutbound('未绑定会话。')
            return
        }

        const engine = this.getSyncEngine()
        if (!engine) {
            console.error(`[Lobstear:${deviceId}] SyncEngine not ready`)
            return
        }

        console.log(`[Lobstear:${deviceId}] → session ${ctx.sessionId}: "${text}"`)
        await engine.sendMessage(ctx.sessionId, { text, sentFrom: 'lobstear' })
    }

    bind(deviceId: string, sessionId: string): boolean {
        const ctx = this.getOrCreateDevice(deviceId)
        const ok = this.bindDevice(ctx, deviceId, sessionId)
        if (ok) {
            this.deviceStore.setBridgedSession(deviceId, sessionId)
        }
        return ok
    }

    private bindDevice(ctx: DeviceContext, deviceId: string, sessionId: string): boolean {
        this.unbindDevice(ctx, deviceId)
        const engine = this.getSyncEngine()
        if (!engine) return false

        const session = engine.getSession(sessionId)
        if (!session) return false

        ctx.sessionId = sessionId
        ctx.unsub = engine.subscribe((event: SyncEvent) => {
            if (event.type !== 'message-received') return
            if (!('sessionId' in event) || event.sessionId !== ctx.sessionId) return

            const msg = (event as { message?: { content?: unknown } }).message
            if (!msg?.content) return

            if (ctx.interrupted) return // user interrupted, drop reply

            const text = extractAssistantText(msg.content)
            if (text) {
                ctx.uplink.sendOutbound(text)
            }
        })

        console.log(`[Lobstear:${deviceId}] Bound to session ${sessionId}`)
        return true
    }

    unbind(deviceId: string): void {
        const ctx = this.devices.get(deviceId)
        if (ctx) {
            this.unbindDevice(ctx, deviceId)
            this.deviceStore.setBridgedSession(deviceId, null)
        }
    }

    private unbindDevice(ctx: DeviceContext, deviceId: string): void {
        if (ctx.unsub) {
            ctx.unsub()
            ctx.unsub = null
        }
        if (ctx.sessionId) {
            console.log(`[Lobstear:${deviceId}] Unbound from session ${ctx.sessionId}`)
            ctx.sessionId = null
        }
    }

    deviceStatus(deviceId: string) {
        const ctx = this.devices.get(deviceId)
        const dev = this.deviceStore.getDevice(deviceId)
        return {
            deviceId,
            name: dev?.name ?? deviceId,
            relay: ctx?.uplink.relayConnected ?? false,
            speaker: ctx?.uplink.speakerConnected ?? false,
            sessionId: ctx?.sessionId ?? null
        }
    }

    allDevices() {
        const stored = this.deviceStore.listDevices()
        const ids = new Set(stored.map(d => d.id))
        for (const id of this.devices.keys()) {
            ids.add(id)
        }
        return Array.from(ids).map(id => this.deviceStatus(id))
    }

    stop(): void {
        for (const [deviceId, ctx] of this.devices) {
            this.unbindDevice(ctx, deviceId)
            ctx.uplink.stop()
        }
        this.devices.clear()
    }
}

/** Extract text from an assistant (agent) message content envelope */
function extractAssistantText(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null
    const record = content as Record<string, unknown>

    if (record.role !== 'agent') return null

    const inner = record.content
    if (typeof inner === 'string') return inner

    // HAPI output format: {type: "output", data: {type: "assistant", message: {content: [...]}}}
    if (typeof inner === 'object' && inner !== null) {
        const innerRec = inner as Record<string, unknown>
        if (innerRec.type === 'output' && typeof innerRec.data === 'object' && innerRec.data !== null) {
            const data = innerRec.data as Record<string, unknown>
            if (data.type === 'assistant' && typeof data.message === 'object' && data.message !== null) {
                const msg = data.message as Record<string, unknown>
                if (Array.isArray(msg.content)) {
                    return extractTextBlocks(msg.content)
                }
            }
        }
        if (typeof innerRec.text === 'string') return innerRec.text
    }

    if (Array.isArray(inner)) {
        return extractTextBlocks(inner)
    }

    return null
}

function extractTextBlocks(blocks: unknown[]): string | null {
    const parts: string[] = []
    for (const block of blocks) {
        if (block && typeof block === 'object' && typeof (block as Record<string, unknown>).type === 'string') {
            const b = block as Record<string, unknown>
            if ((b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string') {
                parts.push(b.text)
            }
        }
    }
    return parts.length > 0 ? parts.join('\n').trim() : null
}

const createDeviceSchema = z.object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    sessionId: z.string().min(1).optional()
})

const updateDeviceSchema = z.object({
    name: z.string().min(1).max(128).optional(),
    sessionId: z.string().nullable().optional()
})

/** Create Hono routes for lobstear (mounted under /api/lobstear, auth via middleware) */
export function createLobstearRoutes(service: LobstearService): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const requireDeviceId = (deviceId: string | undefined): string | null => {
        return deviceId?.trim() || null
    }

    // ── Relay endpoints ──

    // GET /down — SSE stream (hub → relay)
    app.get('/down', (c) => {
        const deviceId = requireDeviceId(c.req.query('deviceId'))
        if (!deviceId) return c.json({ error: 'deviceId required' }, 400)

        if (!service.deviceStore.getDevice(deviceId)) return c.json({ error: 'device not registered' }, 403)

        return streamSSE(c, async (stream) => {
            const ctx = service.getOrCreateDevice(deviceId)
            const send = (msg: unknown) => {
                stream.writeSSE({ data: JSON.stringify(msg) })
            }

            ctx.uplink.attachStream(send)

            const keepalive = setInterval(() => {
                stream.write(': keepalive\n\n').catch(() => {})
            }, 15000)

            await new Promise<void>((resolve) => {
                const done = () => {
                    clearInterval(keepalive)
                    resolve()
                }
                c.req.raw.signal.addEventListener('abort', done, { once: true })
                stream.onAbort(done)
            })

            ctx.uplink.detachStream()
        })
    })

    // POST /up — messages from relay
    app.post('/up', async (c) => {
        const deviceId = requireDeviceId(c.req.query('deviceId'))
        if (!deviceId) return c.json({ error: 'deviceId required' }, 400)

        if (!service.deviceStore.getDevice(deviceId)) return c.json({ error: 'device not registered' }, 403)

        const ctx = service.getDevice(deviceId)
        if (!ctx) return c.json({ error: 'device not connected' }, 404)

        const msg = await c.req.json<UplinkUp>()
        ctx.uplink.processUp(msg)
        return c.json({ ok: true })
    })

    // POST /tool — execute a tool on relay, return result synchronously
    // Accepts deviceId directly, or sessionId to auto-resolve the bound device
    app.post('/tool', async (c) => {
        const body = await c.req.json<{ deviceId?: string; sessionId?: string; command?: string; params?: Record<string, unknown>; timeoutMs?: number }>()
        if (!body.command) {
            return c.json({ error: 'command required' }, 400)
        }

        // Resolve deviceId: explicit, or auto-resolve via session binding
        let deviceId = body.deviceId
        if (!deviceId && body.sessionId) {
            const devices = service.deviceStore.getDevicesBySession(body.sessionId)
            if (devices.length === 0) return c.json({ error: 'no device bound to this session' }, 404)
            if (devices.length > 1) {
                return c.json({
                    error: `multiple devices bound to this session (${devices.map(d => d.id).join(', ')}), specify deviceId`,
                    devices: devices.map(d => ({ id: d.id, name: d.name }))
                }, 400)
            }
            deviceId = devices[0].id
        }
        if (!deviceId) {
            return c.json({ error: 'deviceId or sessionId required' }, 400)
        }

        const ctx = service.getDevice(deviceId)
        if (!ctx) return c.json({ error: 'device not connected (relay offline)' }, 404)

        const result = await ctx.uplink.callTool(body.command, body.params ?? {}, body.timeoutMs ?? 30000)
        return c.json(result)
    })

    // ── Device CRUD (web UI + API) ──

    // GET /devices — list all devices with status
    app.get('/devices', (c) => {
        const speakers = service.allDevices().map(d => ({
            id: d.deviceId,
            name: d.name,
            sessionId: d.sessionId,
            relay: d.relay,
            speaker: d.speaker,
        }))
        return c.json({ speakers })
    })

    // POST /devices — register a new device
    app.post('/devices', async (c) => {
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)
        const parsed = createDeviceSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body: id and name required' }, 400)

        if (service.deviceStore.getDevice(parsed.data.id)) {
            return c.json({ error: 'Device ID already exists' }, 409)
        }

        const device = service.deviceStore.upsertDevice(parsed.data.id, parsed.data.name, namespace)

        if (parsed.data.sessionId) {
            service.bind(parsed.data.id, parsed.data.sessionId)
        }

        const updated = service.deviceStore.getDevice(parsed.data.id)!
        return c.json({
            speaker: { id: updated.id, name: updated.name, sessionId: updated.bridgedSessionId }
        }, 201)
    })

    // PUT /devices/:id — update name and/or session binding
    app.put('/devices/:id', async (c) => {
        const id = c.req.param('id')
        const device = service.deviceStore.getDevice(id)
        if (!device) return c.json({ error: 'Device not found' }, 404)

        const body = await c.req.json().catch(() => null)
        const parsed = updateDeviceSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        if (parsed.data.name !== undefined) {
            service.deviceStore.upsertDevice(id, parsed.data.name, device.namespace)
        }

        if (parsed.data.sessionId !== undefined) {
            if (parsed.data.sessionId) {
                const ok = service.bind(id, parsed.data.sessionId)
                if (!ok) return c.json({ error: 'Session not found' }, 404)
            } else {
                service.unbind(id)
            }
        }

        const updated = service.deviceStore.getDevice(id)!
        return c.json({
            speaker: { id: updated.id, name: updated.name, sessionId: updated.bridgedSessionId }
        })
    })

    // DELETE /devices/:id — unregister device
    app.delete('/devices/:id', (c) => {
        const id = c.req.param('id')
        if (!service.deviceStore.getDevice(id)) return c.json({ error: 'Device not found' }, 404)

        service.unbind(id)
        service.deviceStore.removeDevice(id)
        return c.json({ ok: true })
    })

    return app
}
