import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CredentialConfig } from '@hapi/protocol'
import { piProvider } from '@/credentials/adapters'

export async function preparePiProvider(config: CredentialConfig | undefined, model?: string): Promise<{
    env?: NodeJS.ProcessEnv
    model?: string
    dispose: () => Promise<void>
}> {
    if (!config) return { dispose: async () => {} }
    const dir = await mkdtemp(join(tmpdir(), 'hapi-pi-provider-'))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { [config.provider]: piProvider(config) } }), { mode: 0o600 })
    return {
        env: { PI_CODING_AGENT_DIR: dir },
        model: `${config.provider}/${model ?? config.defaultModel}`,
        dispose: () => rm(dir, { recursive: true, force: true })
    }
}
