import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PiProviderConfig } from './types'

export async function preparePiProvider(config: PiProviderConfig | undefined): Promise<{
    env?: NodeJS.ProcessEnv
    model?: string
    dispose: () => Promise<void>
}> {
    if (!config) return { dispose: async () => {} }
    if (!config.provider?.trim() || !config.model?.trim()) throw new Error('Pi provider and model are required')
    const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-provider-'))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const model = {
        id: config.model,
        ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
        ...(config.maxTokens ? { maxTokens: config.maxTokens } : {})
    }
    const provider = {
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.protocol || config.api ? { api: config.protocol ?? config.api } : {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
        models: [model]
    }
    await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { [config.provider]: provider } }), { mode: 0o600 })
    return {
        env: { PI_CODING_AGENT_DIR: dir },
        model: `${config.provider}/${config.model}`,
        dispose: () => rm(dir, { recursive: true, force: true })
    }
}
