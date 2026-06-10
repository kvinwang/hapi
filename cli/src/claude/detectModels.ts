/**
 * Dynamic Claude model list detection.
 *
 * Claude Code's stream-json control protocol answers an `initialize` control request
 * with the account-specific list of selectable models (the same data the official
 * Agent SDK exposes as `query.supportedModels()`). We spawn a short-lived `claude`
 * process, send the request, read the response and kill the process — no user
 * message is ever sent, so no tokens are consumed.
 *
 * Results are cached on disk (keyed by the Claude Code version) so that
 * `buildMachineMetadata()` can include them synchronously: the hub overwrites
 * machine metadata wholesale on every `getOrCreateMachine`, so the models must be
 * part of every metadata payload, not patched in once.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { ClaudeModelInfoSchema } from '@hapi/protocol/schemas'
import type { ClaudeModelInfo } from '@hapi/protocol/types'
import { getDefaultClaudeCodePath } from './sdk/utils'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { killProcessByChildProcess } from '@/utils/process'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'

const DETECT_TIMEOUT_MS = 45_000
const REQUEST_ID = 'hapi-detect-models'

const CachedModelsSchema = z.object({
    models: z.array(ClaudeModelInfoSchema),
    detectedAt: z.number(),
    claudeVersion: z.string().optional()
})

type CachedModels = z.infer<typeof CachedModelsSchema>

function cacheFilePath(): string {
    return join(configuration.happyHomeDir, 'claude-models.json')
}

/**
 * Read the cached model list (synchronous so buildMachineMetadata can use it).
 * Returns null when no cache exists or it cannot be parsed.
 */
export function readCachedClaudeModels(): CachedModels | null {
    try {
        const raw = readFileSync(cacheFilePath(), 'utf-8')
        const parsed = CachedModelsSchema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

function writeCachedClaudeModels(cache: CachedModels): void {
    try {
        const path = cacheFilePath()
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8')
    } catch (error) {
        logger.debug('[detectModels] Failed to write model cache', error)
    }
}

type InitializeModelEntry = {
    value?: unknown
    displayName?: unknown
    description?: unknown
}

function toClaudeModelInfo(entry: InitializeModelEntry): ClaudeModelInfo | null {
    if (typeof entry?.value !== 'string' || entry.value.length === 0) return null
    if (typeof entry.displayName !== 'string' || entry.displayName.length === 0) return null
    return {
        value: entry.value,
        displayName: entry.displayName,
        ...(typeof entry.description === 'string' && entry.description.length > 0
            ? { description: entry.description }
            : {})
    }
}

/**
 * Probe the local Claude Code CLI for its supported model list.
 * Returns null when claude is missing, the probe times out, or the response is malformed.
 */
export async function detectClaudeModels(opts?: { timeoutMs?: number }): Promise<ClaudeModelInfo[] | null> {
    let claudePath: string
    try {
        claudePath = getDefaultClaudeCodePath()
    } catch (error) {
        logger.debug('[detectModels] Claude Code CLI not found, skipping model detection', error)
        return null
    }
    if (claudePath !== 'claude' && !existsSync(claudePath)) {
        logger.debug(`[detectModels] Claude Code executable not found at ${claudePath}`)
        return null
    }

    const timeoutMs = opts?.timeoutMs ?? DETECT_TIMEOUT_MS

    const spawnEnv = withBunRuntimeEnv(process.env, { allowBunBeBun: false })
    // Prevent Claude's nested session guard from blocking the probe
    delete spawnEnv.CLAUDECODE
    if (!spawnEnv.CLAUDE_CODE_ENTRYPOINT) {
        spawnEnv.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    }

    return new Promise<ClaudeModelInfo[] | null>((resolve) => {
        let settled = false

        const child = spawn(claudePath, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
            cwd: homedir(),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: process.platform === 'win32'
        })

        const settle = (result: ClaudeModelInfo[] | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            void killProcessByChildProcess(child, true)
            resolve(result)
        }

        const timer = setTimeout(() => {
            logger.debug(`[detectModels] Probe timed out after ${timeoutMs}ms`)
            settle(null)
        }, timeoutMs)

        child.on('error', (error) => {
            logger.debug('[detectModels] Failed to spawn Claude Code for model detection', error)
            settle(null)
        })

        child.on('close', () => {
            settle(null)
        })

        const rl = createInterface({ input: child.stdout })
        rl.on('line', (line) => {
            const trimmed = line.trim()
            if (!trimmed) return
            try {
                const message = JSON.parse(trimmed) as {
                    type?: string
                    response?: {
                        request_id?: string
                        subtype?: string
                        response?: { models?: InitializeModelEntry[] }
                    }
                }
                if (message.type !== 'control_response' || message.response?.request_id !== REQUEST_ID) {
                    return
                }
                if (message.response.subtype !== 'success') {
                    logger.debug('[detectModels] initialize control request failed')
                    settle(null)
                    return
                }
                const rawModels = message.response.response?.models
                if (!Array.isArray(rawModels)) {
                    logger.debug('[detectModels] initialize response has no models array')
                    settle(null)
                    return
                }
                const models = rawModels
                    .map(toClaudeModelInfo)
                    .filter((m): m is ClaudeModelInfo => m !== null)
                settle(models.length > 0 ? models : null)
            } catch {
                // Non-JSON output lines are expected noise; ignore
            }
        })

        try {
            child.stdin.write(JSON.stringify({
                request_id: REQUEST_ID,
                type: 'control_request',
                request: { subtype: 'initialize' }
            }) + '\n')
        } catch (error) {
            logger.debug('[detectModels] Failed to write initialize request', error)
            settle(null)
        }
    })
}

/**
 * Detect models and persist them in the on-disk cache.
 * Returns the freshly detected models, or null when detection failed
 * (the existing cache is kept as-is in that case).
 */
export async function detectAndCacheClaudeModels(opts?: { timeoutMs?: number; claudeVersion?: string }): Promise<ClaudeModelInfo[] | null> {
    const models = await detectClaudeModels(opts)
    if (!models) {
        return null
    }
    writeCachedClaudeModels({
        models,
        detectedAt: Date.now(),
        ...(opts?.claudeVersion ? { claudeVersion: opts.claudeVersion } : {})
    })
    logger.debug(`[detectModels] Detected ${models.length} Claude models: ${models.map((m) => m.value).join(', ')}`)
    return models
}
