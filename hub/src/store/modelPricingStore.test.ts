import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('ModelPricingStore', () => {
    it('isolates prices by namespace and updates models', () => {
        const store = new Store(':memory:')
        store.modelPricing.set('a', {
            model: 'claude-test',
            inputPerMillion: 3,
            outputPerMillion: 15,
            cachedInputPerMillion: 0.3
        })

        expect(store.modelPricing.get('b', 'claude-test')).toBeNull()
        expect(store.modelPricing.get('a', 'claude-test')).toMatchObject({
            inputPerMillion: 3,
            outputPerMillion: 15,
            cachedInputPerMillion: 0.3
        })

        store.modelPricing.set('a', {
            model: 'claude-test',
            inputPerMillion: 4,
            outputPerMillion: 16,
            cachedInputPerMillion: 0.4
        })
        expect(store.modelPricing.list('a')).toHaveLength(1)
        expect(store.modelPricing.get('a', 'claude-test')?.inputPerMillion).toBe(4)
    })
})
