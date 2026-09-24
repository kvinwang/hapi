/**
 * WebSocket client for machine/runner communication with hapi-hub
 */

import { io, type Socket } from 'socket.io-client'
import { createConnection, type Socket as NetSocket } from 'node:net'
import { stat } from 'node:fs/promises'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { CredentialAgentSchema, CredentialConfigSchema, type Update, type UpdateMachineBody } from '@hapi/protocol'
import type { RunnerState, Machine, MachineMetadata } from './types'
import { RunnerStateSchema, MachineMetadataSchema } from './types'
import { backoff } from '@/utils/time'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import type { SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'
import { applyVersionedAck } from './versionedUpdate'
import { buildSocketIoExtraHeaderOptions } from './hubExtraHeaders'
import { applyCredential, readCredential } from '@/credentials/machine'

interface ServerToRunnerEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    'tunnel:open': (data: { tunnelId: string; port: number; host?: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'hub:hello': (data: { capabilities?: { wsPool?: boolean } }) => void
    replaced: (data: { reason?: string }) => void
    error: (data: { message: string }) => void
}

interface RunnerToServerEvents {
    'machine-alive': (data: { machineId: string; time: number }) => void
    'machine-update-metadata': (data: { machineId: string; metadata: unknown; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        metadata: unknown | null
    } | {
        result: 'success'
        version: number
        metadata: unknown | null
    }) => void) => void
    'machine-update-state': (data: { machineId: string; runnerState: unknown | null; expectedVersion: number }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        runnerState: unknown | null
    } | {
        result: 'success'
        version: number
        runnerState: unknown | null
    }) => void) => void
    'rpc-register': (data: { method: string }) => void
    'rpc-unregister': (data: { method: string }) => void
    'tunnel:ready': (data: { tunnelId: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'tunnel:error': (data: { tunnelId: string; message: string }) => void
}

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
    stopSession: (sessionId: string) => boolean
    requestShutdown: () => void
}

interface PathExistsRequest {
    paths: string[]
}

interface PathExistsResponse {
    exists: Record<string, boolean>
}

export class ApiMachineClient {
    private socket!: Socket<ServerToRunnerEvents, RunnerToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private rpcHandlerManager: RpcHandlerManager
    private readonly tunnels = new Map<string, NetSocket>()
    private readonly tunnelWs = new Map<string, WebSocket>()
    private poolWs: WebSocket | null = null
    private poolWsEnabled = false

    constructor(
        private readonly token: string,
        private readonly machine: Machine
    ) {
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })

        registerCommonHandlers(this.rpcHandlerManager, getInvokedCwd())

        this.rpcHandlerManager.registerHandler('apply-credentials', async (params: { agent?: unknown; config?: unknown }) => {
            const agent = CredentialAgentSchema.safeParse(params?.agent)
            const config = CredentialConfigSchema.safeParse(params?.config)
            if (!agent.success || !config.success) {
                return { success: false, error: 'Invalid agent or credential' }
            }
            try {
                const written = await applyCredential(agent.data, config.data)
                logger.debug(`[RPC] Applied ${agent.data} credential: ${written.join(', ')}`)
                return { success: true, written }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
            }
        })

        this.rpcHandlerManager.registerHandler('read-credentials', async (params: { agent?: unknown }) => {
            const agent = CredentialAgentSchema.safeParse(params?.agent)
            if (!agent.success) {
                return { success: false, error: 'Invalid agent' }
            }
            const config = await readCredential(agent.data)
            return config ? { success: true, config } : { success: false, error: `No ${agent.data} API credential found` }
        })

        this.rpcHandlerManager.registerHandler('import-ssh-key', async (params: { publicKey?: string }) => {
            const { readFile, writeFile, mkdir, chmod } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const { homedir } = await import('node:os')

            const publicKey = params?.publicKey?.trim()
            if (!publicKey) {
                return { success: false, error: 'Missing publicKey' }
            }

            const validPrefixes = ['ssh-rsa', 'ssh-ed25519', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519', 'sk-ecdsa-sha2-nistp256']
            if (!validPrefixes.some(prefix => publicKey.startsWith(prefix))) {
                return { success: false, error: 'Invalid SSH public key format' }
            }

            try {
                const sshDir = join(homedir(), '.ssh')
                await mkdir(sshDir, { recursive: true, mode: 0o700 })
                await chmod(sshDir, 0o700)

                const authKeysPath = join(sshDir, 'authorized_keys')

                let existing = ''
                try {
                    existing = await readFile(authKeysPath, 'utf-8')
                } catch { /* file does not exist yet */ }

                // Compare by key type + key data (ignore comment)
                const keyParts = publicKey.split(/\s+/)
                const keyFingerprint = keyParts.length >= 2 ? `${keyParts[0]} ${keyParts[1]}` : publicKey

                const username = process.env.USER || process.env.LOGNAME || 'unknown'

                if (existing.includes(keyFingerprint)) {
                    return { success: true, added: false, message: `Key already present in ~${username}/.ssh/authorized_keys` }
                }

                const newContent = existing.endsWith('\n') || existing === ''
                    ? existing + publicKey + '\n'
                    : existing + '\n' + publicKey + '\n'

                await writeFile(authKeysPath, newContent, { mode: 0o600 })

                logger.debug(`[RPC] Imported SSH key to ${authKeysPath}`)
                return { success: true, added: true, message: `Key added to ~${username}/.ssh/authorized_keys` }
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
        })

        this.rpcHandlerManager.registerHandler<PathExistsRequest, PathExistsResponse>('path-exists', async (params) => {
            const rawPaths = Array.isArray(params?.paths) ? params.paths : []
            const uniquePaths = Array.from(new Set(rawPaths.filter((path): path is string => typeof path === 'string')))
            const exists: Record<string, boolean> = {}

            await Promise.all(uniquePaths.map(async (path) => {
                const trimmed = path.trim()
                if (!trimmed) return
                try {
                    const stats = await stat(trimmed)
                    exists[trimmed] = stats.isDirectory()
                } catch {
                    exists[trimmed] = false
                }
            }))

            return { exists }
        })
    }

    setRPCHandlers({ spawnSession, stopSession, requestShutdown }: MachineRpcHandlers): void {
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            const { directory, sessionId, resumeSessionId, machineId, approvedNewDirectoryCreation, agent, model, yolo, token, sessionType, worktreeName, forkSourceSessionId, forkAtTimestamp, sessionTag, parentSessionId } = params || {}

            if (!directory) {
                throw new Error('Directory is required')
            }

            const result = await spawnSession({
                directory,
                sessionId,
                resumeSessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                yolo,
                token,
                sessionType,
                worktreeName,
                forkSourceSessionId,
                forkAtTimestamp,
                sessionTag,
                parentSessionId
            })

            switch (result.type) {
                case 'success':
                    return { type: 'success', sessionId: result.sessionId }
                case 'requestToApproveDirectoryCreation':
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory }
                case 'error':
                    return { type: 'error', errorMessage: result.errorMessage }
            }
        })

        this.rpcHandlerManager.registerHandler('stop-session', (params: any) => {
            const { sessionId } = params || {}
            if (!sessionId) {
                throw new Error('Session ID is required')
            }

            const success = stopSession(sessionId)
            if (!success) {
                throw new Error('Session not found or failed to stop')
            }

            return { message: 'Session stopped' }
        })

        this.rpcHandlerManager.registerHandler('stop-runner', () => {
            setTimeout(() => requestShutdown(), 100)
            return { message: 'Runner stop request acknowledged' }
        })

        this.rpcHandlerManager.registerHandler('get-usage', async (params: unknown) => {
            try {
                const { readFile } = await import('node:fs/promises')
                const { join } = await import('node:path')
                const { homedir } = await import('node:os')

                const provider = typeof (params as { provider?: unknown })?.provider === 'string'
                    ? (params as { provider: string }).provider
                    : null

                if (provider === 'codex') {
                    const authPath = join(homedir(), '.codex', 'auth.json')
                    const raw = await readFile(authPath, 'utf-8')
                    const auth = JSON.parse(raw)
                    const authMode = typeof auth?.auth_mode === 'string' ? auth.auth_mode : null

                    if (authMode === 'chatgpt') {
                        const accessToken = auth?.tokens?.access_token
                        if (typeof accessToken !== 'string' || accessToken.length === 0) {
                            return { success: false, error: 'No Codex ChatGPT access token found' }
                        }

                        const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
                            headers: {
                                Authorization: `Bearer ${accessToken}`,
                                Accept: 'application/json',
                                'User-Agent': 'codex-cli/1.0'
                            },
                            signal: AbortSignal.timeout(5000)
                        })

                        if (!response.ok) {
                            const text = await response.text().catch(() => '')
                            if (response.status === 404) {
                                return { success: false, error: 'Codex account usage is not available for this authentication method' }
                            }
                            return { success: false, error: `API error ${response.status}: ${text}` }
                        }

                        const usage = await response.json()
                        return { success: true, provider: 'codex', usage }
                    }

                    const apiKey = auth?.OPENAI_API_KEY
                    if (typeof apiKey === 'string' && apiKey.length > 0) {
                        const response = await fetch('https://api.openai.com/api/codex/usage', {
                            headers: {
                                Authorization: `Bearer ${apiKey}`,
                                Accept: 'application/json',
                                'User-Agent': 'codex-cli/1.0'
                            },
                            signal: AbortSignal.timeout(5000)
                        })

                        if (!response.ok) {
                            const text = await response.text().catch(() => '')
                            if (response.status === 404) {
                                return { success: false, error: 'Codex account usage is not available for API-key authentication' }
                            }
                            return { success: false, error: `API error ${response.status}: ${text}` }
                        }

                        const usage = await response.json()
                        return { success: true, provider: 'codex', usage }
                    }

                    return { success: false, error: 'Codex auth is not available on this machine' }
                }

                if (provider === 'grok') {
                    // Prefer OAuth session token from ~/.grok/auth.json; fall back to XAI_API_KEY.
                    let accessToken: string | null = null
                    try {
                        const authPath = join(homedir(), '.grok', 'auth.json')
                        const raw = await readFile(authPath, 'utf-8')
                        const auth = JSON.parse(raw) as Record<string, unknown>
                        for (const value of Object.values(auth)) {
                            if (!value || typeof value !== 'object') continue
                            const entry = value as Record<string, unknown>
                            if (typeof entry.key === 'string' && entry.key.length > 0) {
                                accessToken = entry.key
                                break
                            }
                        }
                    } catch {
                        // No session file — try env below.
                    }
                    if (!accessToken) {
                        const envKey = process.env.XAI_API_KEY ?? process.env.GROK_API_KEY
                        if (typeof envKey === 'string' && envKey.length > 0) {
                            accessToken = envKey
                        }
                    }
                    if (!accessToken) {
                        return { success: false, error: 'No Grok OAuth token or XAI_API_KEY found' }
                    }

                    // Grok Build TUI /usage uses cli-chat-proxy billing:
                    // - default → monthly dollar/credit pool + history
                    // - ?format=credits → rolling weekly percent (matches TUI "Weekly limit")
                    const base = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL
                        ?? process.env.CLI_CHAT_PROXY_BASE_URL
                        ?? 'https://cli-chat-proxy.grok.com/v1').replace(/\/$/, '')
                    const headers = {
                        Authorization: `Bearer ${accessToken}`,
                        Accept: 'application/json',
                        'User-Agent': 'HAPI/1.0',
                        'x-grok-client-version': '0.2.93'
                    } as const

                    const fetchBilling = async (url: string): Promise<{ ok: boolean; status: number; body: unknown; text: string }> => {
                        const response = await fetch(url, {
                            headers,
                            signal: AbortSignal.timeout(5000)
                        })
                        const text = await response.text().catch(() => '')
                        if (!response.ok) {
                            return { ok: false, status: response.status, body: null, text }
                        }
                        try {
                            return { ok: true, status: response.status, body: JSON.parse(text) as unknown, text }
                        } catch {
                            return { ok: false, status: response.status, body: null, text: `Invalid JSON: ${text.slice(0, 200)}` }
                        }
                    }

                    const [creditsResult, monthlyResult] = await Promise.all([
                        fetchBilling(`${base}/billing?format=credits`),
                        fetchBilling(`${base}/billing`)
                    ])

                    if (!creditsResult.ok && !monthlyResult.ok) {
                        const detail = creditsResult.text || monthlyResult.text
                        return {
                            success: false,
                            error: `API error ${creditsResult.status || monthlyResult.status}: ${detail}`
                        }
                    }

                    const asRecord = (value: unknown): Record<string, unknown> | null =>
                        value && typeof value === 'object' && !Array.isArray(value)
                            ? value as Record<string, unknown>
                            : null

                    const creditsRoot = asRecord(creditsResult.body)
                    const monthlyRoot = asRecord(monthlyResult.body)
                    const creditsConfig = asRecord(creditsRoot?.config) ?? creditsRoot
                    const monthlyConfig = asRecord(monthlyRoot?.config) ?? monthlyRoot

                    // Prefer weekly/credits shape as primary config (what TUI /usage shows),
                    // and attach monthly pool fields alongside when available.
                    const mergedConfig: Record<string, unknown> = {
                        ...(monthlyConfig ?? {}),
                        ...(creditsConfig ?? {})
                    }
                    if (monthlyConfig) {
                        if (monthlyConfig.monthlyLimit !== undefined) {
                            mergedConfig.monthlyLimit = monthlyConfig.monthlyLimit
                        }
                        if (monthlyConfig.used !== undefined) {
                            mergedConfig.used = monthlyConfig.used
                        }
                        if (monthlyConfig.history !== undefined) {
                            mergedConfig.history = monthlyConfig.history
                        }
                        // Keep calendar month bounds separate from rolling weekly period.
                        if (monthlyConfig.billingPeriodStart !== undefined) {
                            mergedConfig.monthlyPeriodStart = monthlyConfig.billingPeriodStart
                        }
                        if (monthlyConfig.billingPeriodEnd !== undefined) {
                            mergedConfig.monthlyPeriodEnd = monthlyConfig.billingPeriodEnd
                        }
                    }

                    return {
                        success: true,
                        provider: 'grok',
                        usage: { config: mergedConfig }
                    }
                }

                return { success: false, error: 'Unsupported usage provider' }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
            }
        })
    }

    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata)

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: updated,
                expectedVersion: this.machine.metadataVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'metadata',
                parseValue: (value) => {
                    const parsed = MachineMetadataSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.metadata = value
                },
                applyVersion: (version) => {
                    this.machine.metadataVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid metadata value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-metadata response',
                errorMessage: 'Machine metadata update failed',
                versionMismatchMessage: 'Metadata version mismatch'
            })
        })
    }

    async updateRunnerState(handler: (state: RunnerState | null) => RunnerState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.runnerState)

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                runnerState: updated,
                expectedVersion: this.machine.runnerStateVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'runnerState',
                parseValue: (value) => {
                    const parsed = RunnerStateSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.runnerState = value
                },
                applyVersion: (version) => {
                    this.machine.runnerStateVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid runnerState value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-state response',
                errorMessage: 'Machine state update failed',
                versionMismatchMessage: 'Runner state version mismatch'
            })
        })
    }

    connect(): void {
        this.socket = io(`${configuration.apiUrl}/cli`, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                username: process.env.USER || process.env.LOGNAME || 'unknown',
                capabilities: { wsTunnel: true }
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            ...buildSocketIoExtraHeaderOptions()
        })

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to bot')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            this.updateRunnerState((state) => ({
                ...(state ?? {}),
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.runnerState?.httpPort,
                startedAt: Date.now()
            })).catch((error) => {
                logger.debug('[API MACHINE] Failed to update runner state on connect', error)
            })
            this.startKeepAlive()
        })

        this.socket.on('hub:hello', (data) => {
            if (data.capabilities?.wsPool && !this.poolWsEnabled) {
                this.poolWsEnabled = true
                this.spawnPoolWs()
            }
        })

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from bot')
            this.rpcHandlerManager.onSocketDisconnect()
            this.stopKeepAlive()
            this.closePoolWs()
        })

        this.socket.on('replaced', (data) => {
            logger.warn(`[API MACHINE] *** REPLACED by another runner: ${data.reason ?? 'unknown'} ***`)
            logger.warn('[API MACHINE] *** This runner will NOT reconnect. Exiting. ***')
            this.socket.disconnect()
            process.exit(1)
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('tunnel:open', (data) => {
            this.handleTunnelOpen(data.tunnelId, data.port, data.host)
        })

        this.socket.on('tunnel:data', (data) => {
            // Always process Socket.IO data — hub may send via Socket.IO fallback
            // even when the runner has a WS open (mixed transport race)
            const tcpSocket = this.tunnels.get(data.tunnelId)
            if (!tcpSocket) return
            tcpSocket.write(Buffer.from(data.data, 'base64'))
        })

        this.socket.on('tunnel:close', (data) => {
            const tcpSocket = this.tunnels.get(data.tunnelId)
            if (!tcpSocket) return
            tcpSocket.destroy()
            this.cleanupTunnel(data.tunnelId)
        })

        this.socket.on('update', (data: Update) => {
            if (data.body.t !== 'update-machine') {
                return
            }

            const update = data.body as UpdateMachineBody
            if (update.machineId !== this.machine.id) {
                return
            }

            if (update.metadata) {
                const parsed = MachineMetadataSchema.safeParse(update.metadata.value)
                if (parsed.success) {
                    this.machine.metadata = parsed.data
                } else {
                    logger.debug('[API MACHINE] Ignoring invalid metadata update', { version: update.metadata.version })
                }
                this.machine.metadataVersion = update.metadata.version
            }

            if (update.runnerState) {
                const next = update.runnerState.value
                if (next == null) {
                    this.machine.runnerState = null
                } else {
                    const parsed = RunnerStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.runnerState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid runnerState update', { version: update.runnerState.version })
                    }
                }
                this.machine.runnerStateVersion = update.runnerState.version
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`)
        })

        this.socket.on('error', (payload) => {
            logger.debug('[API MACHINE] Socket error:', payload)
        })
    }

    private handleTunnelOpen(tunnelId: string, port: number, host?: string): void {
        const tcpSocket = createConnection({ host: host ?? '127.0.0.1', port }, () => {
            this.socket.emit('tunnel:ready', { tunnelId })
            // Pool WS will be assigned by hub after tunnel:ready — no per-tunnel WS needed
        })

        tcpSocket.on('data', (chunk: Buffer) => {
            const ws = this.tunnelWs.get(tunnelId)
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(chunk)
            } else {
                // Socket.IO fallback
                this.socket.emit('tunnel:data', { tunnelId, data: chunk.toString('base64') })
            }
        })

        tcpSocket.on('close', () => {
            this.cleanupTunnel(tunnelId)
            this.socket.emit('tunnel:close', { tunnelId })
        })

        tcpSocket.on('error', (err) => {
            this.cleanupTunnel(tunnelId)
            this.socket.emit('tunnel:error', { tunnelId, message: err.message })
        })

        this.tunnels.set(tunnelId, tcpSocket)
    }

    private spawnPoolWs(): void {
        if (this.poolWs) return
        const base = configuration.apiUrl.replace(/^http/, 'ws')
        const wsUrl = `${base}/tunnel/pool?token=${encodeURIComponent(this.token)}&machineId=${encodeURIComponent(this.machine.id)}`
        const ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'
        this.poolWs = ws

        ws.addEventListener('open', () => {
            logger.debug('[API MACHINE] Pool WS connected')
        })

        ws.addEventListener('message', (event) => {
            if (typeof event.data === 'string') {
                // Control message — assignment
                try {
                    const msg = JSON.parse(event.data)
                    if (msg.assign) {
                        this.handlePoolAssign(msg.assign, ws)
                    }
                } catch {}
                return
            }
            // Binary data — relay to TCP
            const tunnelId = (ws as any).__tunnelId as string | undefined
            if (!tunnelId) return
            const tcp = this.tunnels.get(tunnelId)
            if (tcp) {
                tcp.write(Buffer.from(event.data as ArrayBuffer))
            }
        })

        ws.addEventListener('close', () => {
            const assignedTunnelId = (ws as any).__tunnelId as string | undefined
            if (this.poolWs === ws) this.poolWs = null
            if (assignedTunnelId) {
                this.tunnelWs.delete(assignedTunnelId)
                const tcp = this.tunnels.get(assignedTunnelId)
                if (tcp) {
                    tcp.destroy()
                    this.tunnels.delete(assignedTunnelId)
                }
            }
            // Replenish if still enabled
            if (this.poolWsEnabled) {
                this.spawnPoolWs()
            }
        })

        ws.addEventListener('error', () => {
            if (this.poolWs === ws) this.poolWs = null
            // Will reconnect via close handler
        })
    }

    private handlePoolAssign(tunnelId: string, ws: WebSocket): void {
        logger.debug(`[API MACHINE] Pool WS assigned to tunnel ${tunnelId}`)
        ;(ws as any).__tunnelId = tunnelId
        this.tunnelWs.set(tunnelId, ws)
        // This WS is now dedicated to this tunnel — spawn a replacement
        this.poolWs = null
        this.spawnPoolWs()
    }

    private closePoolWs(): void {
        this.poolWsEnabled = false
        if (this.poolWs) {
            try { this.poolWs.close() } catch {}
            this.poolWs = null
        }
    }

    private cleanupTunnel(tunnelId: string): void {
        this.tunnels.delete(tunnelId)
        const ws = this.tunnelWs.get(tunnelId)
        if (ws) {
            try { ws.close() } catch {}
            this.tunnelWs.delete(tunnelId)
        }
    }

    private startKeepAlive(): void {
        this.stopKeepAlive()
        this.keepAliveInterval = setInterval(() => {
            this.socket.emit('machine-alive', {
                machineId: this.machine.id,
                time: Date.now()
            })
        }, 20_000)
    }

    private stopKeepAlive(): void {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval)
            this.keepAliveInterval = null
        }
    }

    shutdown(): void {
        this.stopKeepAlive()
        this.closePoolWs()
        for (const [, ws] of this.tunnelWs) {
            try { ws.close() } catch {}
        }
        this.tunnelWs.clear()
        for (const [, tcpSocket] of this.tunnels) {
            tcpSocket.destroy()
        }
        this.tunnels.clear()
        if (this.socket) {
            this.socket.close()
        }
    }
}
