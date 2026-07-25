import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForElementById } from './wait-for-element'

describe('waitForElementById', () => {
    afterEach(() => {
        document.body.replaceChildren()
        vi.useRealTimers()
    })

    it('resolves when the committed target is added', async () => {
        const result = waitForElementById('target')
        const target = document.createElement('div')
        target.id = 'target'
        document.body.appendChild(target)
        expect(await result).toBe(target)
    })

    it('returns null after the timeout', async () => {
        vi.useFakeTimers()
        const result = waitForElementById('missing', 100)
        await vi.advanceTimersByTimeAsync(100)
        expect(await result).toBeNull()
    })
})
