import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMachineMetadata, buildSessionMetadata } from './sessionFactory'

describe('buildSessionMetadata', () => {
    const originalHostname = process.env.HAPI_HOSTNAME

    afterEach(() => {
        if (originalHostname === undefined) {
            delete process.env.HAPI_HOSTNAME
        } else {
            process.env.HAPI_HOSTNAME = originalHostname
        }
    })

    it('uses HAPI_HOSTNAME for session metadata host when provided', () => {
        process.env.HAPI_HOSTNAME = 'custom-session-host'

        const metadata = buildSessionMetadata({
            flavor: 'codex',
            startedBy: 'terminal',
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            now: 123
        })

        expect(metadata.host).toBe('custom-session-host')
    })
})

vi.mock('@/claude/detectModels', () => ({ readCachedClaudeModels: () => null }))
vi.mock('@/codex/detectModels', () => ({
    readCachedCodexModels: () => ({
        models: [{ value: 'cached-model', displayName: 'Cached Model' }],
        detectedAt: 123
    })
}))

describe('buildMachineMetadata', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('includes cached Codex models in every registration payload', () => {
        vi.stubEnv('HAPI_MACHINE_NAME', 'test-machine')
        for (let i = 0; i < 2; i++) {
            expect(buildMachineMetadata()).toMatchObject({
                codexModels: [{ value: 'cached-model', displayName: 'Cached Model' }],
                codexModelsDetectedAt: 123
            })
        }
    })
})
