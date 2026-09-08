import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    home: '', connect: vi.fn(), initialize: vi.fn(), listModels: vi.fn(), disconnect: vi.fn()
}))
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return mocks.home } } }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))
vi.mock('./codexAppServerClient', () => ({
    CodexAppServerClient: class {
        connect = mocks.connect
        initialize = mocks.initialize
        listModels = mocks.listModels
        disconnect = mocks.disconnect
    }
}))

import { detectAndCacheCodexModels, readCachedCodexModels } from './detectModels'

describe('Codex model cache', () => {
    const models = [{ value: 'account-model', displayName: 'Account Model', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }], defaultReasoningEffort: 'xhigh', isDefault: true }]

    beforeEach(() => {
        mocks.home = mkdtempSync(join(tmpdir(), 'hapi-codex-models-'))
        vi.resetAllMocks()
        mocks.listModels.mockResolvedValue(models)
    })
    afterEach(() => rmSync(mocks.home, { recursive: true, force: true }))

    it('persists a successful probe and disconnects without starting a thread', async () => {
        expect(readCachedCodexModels()).toBeNull()
        expect(await detectAndCacheCodexModels()).toEqual(models)
        expect(readCachedCodexModels()).toEqual({ models, detectedAt: expect.any(Number) })
        expect(mocks.initialize).toHaveBeenCalledOnce()
        expect(mocks.disconnect).toHaveBeenCalledOnce()
    })

    it.each(['empty', 'failure', 'initialization failure'])('preserves the previous cache on %s', async (failure) => {
        await detectAndCacheCodexModels()
        const original = readFileSync(join(mocks.home, 'codex-models.json'), 'utf-8')
        if (failure === 'empty') mocks.listModels.mockResolvedValue([])
        else if (failure === 'failure') mocks.listModels.mockRejectedValue(new Error('Unavailable'))
        else mocks.initialize.mockRejectedValue(new Error('Unavailable'))
        expect(await detectAndCacheCodexModels()).toBeNull()
        expect(readFileSync(join(mocks.home, 'codex-models.json'), 'utf-8')).toBe(original)
        expect(mocks.disconnect).toHaveBeenCalledTimes(2)
    })

    it('ignores corrupt or invalid cache files', () => {
        for (const content of ['not json', '{"models":[{}],"detectedAt":1}']) {
            writeFileSync(join(mocks.home, 'codex-models.json'), content)
            expect(readCachedCodexModels()).toBeNull()
        }
    })
})
