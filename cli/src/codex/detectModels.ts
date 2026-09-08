import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CodexModelInfoSchema } from '@hapi/protocol/schemas'
import type { CodexModelInfo } from '@hapi/protocol/types'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { CodexAppServerClient } from './codexAppServerClient'

const CachedModelsSchema = z.object({
    models: z.array(CodexModelInfoSchema).min(1),
    detectedAt: z.number()
})

function cacheFilePath(): string {
    return join(configuration.happyHomeDir, 'codex-models.json')
}

/** Included in every machine registration so session startup cannot erase the catalog. */
export function readCachedCodexModels(): z.infer<typeof CachedModelsSchema> | null {
    try {
        return CachedModelsSchema.parse(JSON.parse(readFileSync(cacheFilePath(), 'utf-8')))
    } catch {
        return null
    }
}

/** Short-lived app-server probe; no thread or user message, and no inference. */
export async function detectCodexModels(opts?: { timeoutMs?: number }): Promise<CodexModelInfo[] | null> {
    const client = new CodexAppServerClient()
    const signal = AbortSignal.timeout(opts?.timeoutMs ?? 45_000)
    try {
        await client.connect()
        await client.initialize({
            clientInfo: { name: 'hapi-model-discovery', version: '1.0.0' }
        }, { signal })
        const models = await client.listModels({ signal })
        return models.length > 0 ? models : null
    } catch {
        logger.debug('[detectModels] Codex model detection unavailable')
        return null
    } finally {
        await client.disconnect()
    }
}

/** Keep the last successful cache if discovery fails or returns no visible models. */
export async function detectAndCacheCodexModels(opts?: { timeoutMs?: number }): Promise<CodexModelInfo[] | null> {
    const models = await detectCodexModels(opts)
    if (!models) return null
    try {
        const path = cacheFilePath()
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify({ models, detectedAt: Date.now() }, null, 2), 'utf-8')
    } catch {
        logger.debug('[detectModels] Failed to write Codex model cache')
    }
    return models
}
