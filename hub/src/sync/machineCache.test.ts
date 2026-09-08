import { describe, expect, it } from 'bun:test'
import { MachineCache } from './machineCache'
import { EventPublisher } from './eventPublisher'
import { Store } from '../store'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'

describe('MachineCache model catalogs', () => {
    it('preserves discovered Codex models through storage and cache reload', () => {
        const store = new Store(':memory:')
        const publisher = new EventPublisher(new SSEManager(0, new VisibilityTracker()), () => 'default')
        const cache = new MachineCache(store, publisher)
        const metadata = {
            host: 'test', platform: 'linux', happyCliVersion: 'test',
            codexModels: [{ value: 'account-model', displayName: 'Account Model', description: 'Available', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }], defaultReasoningEffort: 'ultra', isDefault: true }],
            codexModelsDetectedAt: 123
        }
        const machine = cache.getOrCreateMachine('test-machine', metadata, null, 'default')
        expect(machine.metadata).toMatchObject(metadata)
        cache.reloadAll()
        expect(cache.getMachine(machine.id)?.metadata).toMatchObject(metadata)
    })
})
