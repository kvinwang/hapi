/**
 * WebSocket client for machine/runner communication with hapi-hub
 */

import { io, type Socket } from 'socket.io-client'
import { createConnection, type Socket as NetSocket } from 'node:net'
import { stat } from 'node:fs/promises'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import type { Update, UpdateMachineBody } from '@hapi/protocol'
import type { RunnerState, Machine, MachineMetadata } from './types'
import { RunnerStateSchema, MachineMetadataSchema } from './types'
import { backoff } from '@/utils/time'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import type { SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'
import { applyVersionedAck } from './versionedUpdate'

interface ServerToRunnerEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    'tunnel:open': (data: { tunnelId: string; port: number; host?: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'hub:capabilities': (data: { wsPool?: boolean }) => void
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

        registerCommonHandlers(this.rpcHandlerManager, process.cwd())

        this.rpcHandlerManager.registerHandler('apply-credentials', async (params: { agentType?: string; config?: unknown }) => {
            const { readFile, writeFile, mkdir } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const { homedir } = await import('node:os')

            const agentType = params?.agentType
            const config = params?.config as Record<string, unknown> | undefined

            if (!agentType || !config) {
                return { success: false, error: 'Missing agentType or config' }
            }

            const written: string[] = []

            try {
                if (agentType === 'claude') {
                    const claudeDir = join(homedir(), '.claude')
                    await mkdir(claudeDir, { recursive: true })

                    const credPath = join(claudeDir, '.credentials.json')
                    if (config.credentials) {
                        // Replace .credentials.json entirely
                        await backupAndWrite(credPath, JSON.stringify(config.credentials, null, 2))
                        written.push('.credentials.json (written)')
                    } else {
                        // Remove old OAuth credentials to ensure clean switch
                        await backupAndRemove(credPath)
                        written.push('.credentials.json (removed)')
                    }

                    const settingsPath = join(claudeDir, 'settings.json')
                    const settingsEnv = (config.settings && typeof config.settings === 'object')
                        ? (config.settings as Record<string, unknown>).env as Record<string, unknown> | undefined
                        : undefined
                    // Always merge settings: if env provided write them, otherwise clear key env fields
                    await mergeClaudeSettings(settingsPath, settingsEnv ?? {})
                    written.push('settings.json')
                } else if (agentType === 'codex') {
                    const codexDir = join(homedir(), '.codex')
                    await mkdir(codexDir, { recursive: true })

                    const authPath = join(codexDir, 'auth.json')
                    if (config.auth) {
                        // Replace auth.json entirely
                        await backupAndWrite(authPath, JSON.stringify(config.auth, null, 2))
                        written.push('auth.json (written)')
                    } else {
                        // Remove old auth to ensure clean switch
                        await backupAndRemove(authPath)
                        written.push('auth.json (removed)')
                    }

                    // config: partial merge into ~/.codex/config.toml
                    if (typeof config.config === 'string') {
                        const configPath = join(codexDir, 'config.toml')
                        await mergeCodexConfig(configPath, config.config)
                        written.push('config.toml')
                    }
                } else {
                    return { success: false, error: `Unsupported agent type: ${agentType}` }
                }

                logger.debug(`[RPC] Applied ${agentType} credentials: ${written.join(', ')}`)
                return { success: true, written }
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                }
            }

            async function backupAndWrite(filePath: string, content: string): Promise<void> {
                try {
                    await readFile(filePath, 'utf-8')
                    const { rename } = await import('node:fs/promises')
                    await rename(filePath, `${filePath}.bak.${Date.now()}`)
                } catch {
                    // file doesn't exist, nothing to back up
                }
                await writeFile(filePath, content, { mode: 0o600 })
            }

            async function backupAndRemove(filePath: string): Promise<void> {
                try {
                    await readFile(filePath, 'utf-8')
                    const { rename } = await import('node:fs/promises')
                    await rename(filePath, `${filePath}.bak.${Date.now()}`)
                } catch {
                    // file doesn't exist, nothing to remove
                }
            }

            async function mergeClaudeSettings(
                settingsPath: string,
                envVars: Record<string, unknown>
            ): Promise<void> {
                // Claude settings.json partial merge: only replace env keys, preserve everything else
                const CLAUDE_KEY_ENV_FIELDS = new Set([
                    'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
                    'ANTHROPIC_MODEL', 'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
                    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                    'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
                    'CLAUDE_CODE_USE_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
                    'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE',
                    'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
                    'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
                    'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
                    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'API_TIMEOUT_MS',
                    'DISABLE_PROMPT_CACHING'
                ])

                let existing: Record<string, unknown> = {}
                try {
                    const raw = await readFile(settingsPath, 'utf-8')
                    existing = JSON.parse(raw)
                } catch {
                    // file doesn't exist or invalid, start fresh
                }

                // Clear old key env fields
                const existingEnv = (existing.env ?? {}) as Record<string, unknown>
                for (const key of CLAUDE_KEY_ENV_FIELDS) {
                    delete existingEnv[key]
                }

                // Merge new env vars
                for (const [key, value] of Object.entries(envVars)) {
                    if (value !== undefined && value !== null && value !== '') {
                        existingEnv[key] = value
                    }
                }

                existing.env = existingEnv
                await writeFile(settingsPath, JSON.stringify(existing, null, 2), { mode: 0o600 })
            }

            async function mergeCodexConfig(
                configPath: string,
                newConfigToml: string
            ): Promise<void> {
                // Codex config.toml partial merge: replace key fields, preserve everything else
                const CODEX_KEY_FIELDS = [
                    'model_provider', 'model', 'model_reasoning_effort',
                    'review_model', 'plan_mode_reasoning_effort', 'disable_response_storage'
                ]

                let existingLines: string[] = []
                try {
                    const raw = await readFile(configPath, 'utf-8')
                    existingLines = raw.split('\n')
                } catch {
                    // file doesn't exist, start fresh
                }

                // Remove old key fields and [model_providers.*] sections from existing
                const filteredLines: string[] = []
                let inModelProviders = false
                for (const line of existingLines) {
                    const trimmed = line.trim()

                    // Detect [model_providers.*] section start
                    if (/^\[model_providers[.\]]/.test(trimmed)) {
                        inModelProviders = true
                        continue
                    }
                    // Detect any other section start — exits model_providers
                    if (inModelProviders && /^\[/.test(trimmed)) {
                        inModelProviders = false
                    }
                    if (inModelProviders) continue

                    // Skip key top-level fields
                    const isKeyField = CODEX_KEY_FIELDS.some(f => trimmed.startsWith(`${f} `) || trimmed.startsWith(`${f}=`))
                    if (isKeyField) continue

                    filteredLines.push(line)
                }

                // Split new config into global key-values vs sections
                const newLines = newConfigToml.trim().split('\n')
                const newGlobalLines: string[] = []
                const newSectionLines: string[] = []
                let inSection = false
                for (const line of newLines) {
                    if (/^\[/.test(line.trim())) inSection = true
                    if (inSection) newSectionLines.push(line)
                    else newGlobalLines.push(line)
                }

                // Insert global keys before the first section, sections at the end
                const resultLines: string[] = []
                let insertedGlobals = false
                for (const line of filteredLines) {
                    if (!insertedGlobals && /^\[/.test(line.trim())) {
                        if (newGlobalLines.length > 0) {
                            resultLines.push(...newGlobalLines, '')
                        }
                        insertedGlobals = true
                    }
                    resultLines.push(line)
                }
                // If no sections in existing file, append globals at end
                if (!insertedGlobals && newGlobalLines.length > 0) {
                    resultLines.push(...newGlobalLines)
                }
                if (newSectionLines.length > 0) {
                    resultLines.push('', ...newSectionLines)
                }

                const merged = resultLines.join('\n').trimEnd() + '\n'
                await writeFile(configPath, merged, { mode: 0o600 })
            }
        })

        this.rpcHandlerManager.registerHandler('read-credentials', async (params: { agentType?: string }) => {
            const { readFile } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const { homedir } = await import('node:os')

            const agentType = params?.agentType
            if (!agentType) {
                return { success: false, error: 'Missing agentType' }
            }

            try {
                if (agentType === 'claude') {
                    const claudeDir = join(homedir(), '.claude')
                    const config: Record<string, unknown> = {}

                    // Read credentials
                    try {
                        const raw = await readFile(join(claudeDir, '.credentials.json'), 'utf-8')
                        config.credentials = JSON.parse(raw)
                    } catch { /* no credentials file */ }

                    // Read settings env vars
                    try {
                        const raw = await readFile(join(claudeDir, 'settings.json'), 'utf-8')
                        const settings = JSON.parse(raw)
                        if (settings.env && typeof settings.env === 'object') {
                            config.settings = { env: settings.env }
                        }
                    } catch { /* no settings file */ }

                    if (Object.keys(config).length === 0) {
                        return { success: false, error: 'No Claude credentials found' }
                    }
                    return { success: true, agentType, config }
                }

                if (agentType === 'codex') {
                    const codexDir = join(homedir(), '.codex')
                    const config: Record<string, unknown> = {}

                    // Read auth.json
                    try {
                        const raw = await readFile(join(codexDir, 'auth.json'), 'utf-8')
                        config.auth = JSON.parse(raw)
                    } catch { /* no auth file */ }

                    // Read config.toml — extract key fields + model_providers
                    try {
                        const raw = await readFile(join(codexDir, 'config.toml'), 'utf-8')
                        config.config = extractCodexKeyConfig(raw)
                    } catch { /* no config file */ }

                    if (Object.keys(config).length === 0) {
                        return { success: false, error: 'No Codex credentials found' }
                    }
                    return { success: true, agentType, config }
                }

                return { success: false, error: `Unsupported agent type: ${agentType}` }
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error)
                }
            }

            function extractCodexKeyConfig(toml: string): string {
                const CODEX_KEY_FIELDS = [
                    'model_provider', 'model', 'model_reasoning_effort',
                    'review_model', 'plan_mode_reasoning_effort', 'disable_response_storage'
                ]
                const lines = toml.split('\n')
                const extracted: string[] = []
                let inModelProviders = false

                for (const line of lines) {
                    const trimmed = line.trim()

                    if (/^\[model_providers[.\]]/.test(trimmed)) {
                        inModelProviders = true
                        extracted.push(line)
                        continue
                    }

                    if (inModelProviders && /^\[/.test(trimmed) && !/^\[model_providers[.\]]/.test(trimmed)) {
                        inModelProviders = false
                    }

                    if (inModelProviders) {
                        extracted.push(line)
                        continue
                    }

                    const isKeyField = CODEX_KEY_FIELDS.some(f => trimmed.startsWith(`${f} `) || trimmed.startsWith(`${f}=`))
                    if (isKeyField) {
                        extracted.push(line)
                    }
                }

                return extracted.join('\n').trim()
            }
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
            const { directory, sessionId, resumeSessionId, machineId, approvedNewDirectoryCreation, agent, model, yolo, token, sessionType, worktreeName, forkSourceSessionId, forkAtTimestamp, sessionTag } = params || {}

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
                sessionTag
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

                if (provider === 'claude') {
                    const credPath = join(homedir(), '.claude', '.credentials.json')
                    const raw = await readFile(credPath, 'utf-8')
                    const creds = JSON.parse(raw)
                    const oauth = creds?.claudeAiOauth
                    if (!oauth?.accessToken) {
                        return { success: false, error: 'No Claude OAuth token found' }
                    }

                    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
                        headers: {
                            Authorization: `Bearer ${oauth.accessToken}`,
                            'Content-Type': 'application/json',
                            'anthropic-beta': 'oauth-2025-04-20',
                            'User-Agent': 'HAPI/1.0'
                        },
                        signal: AbortSignal.timeout(5000)
                    })

                    if (!response.ok) {
                        const text = await response.text().catch(() => '')
                        return { success: false, error: `API error ${response.status}: ${text}` }
                    }

                    const usage = await response.json()
                    return { success: true, provider: 'claude', usage }
                }

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
                            return { success: false, error: `API error ${response.status}: ${text}` }
                        }

                        const usage = await response.json()
                        return { success: true, provider: 'codex', usage }
                    }

                    return { success: false, error: 'Codex auth is not available on this machine' }
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
                capabilities: { wsTunnel: true }
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
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

        this.socket.on('hub:capabilities', (data) => {
            if (data.wsPool && !this.poolWsEnabled) {
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
