import { describe, expect, it } from 'vitest'
import { OutgoingMessageQueue } from './OutgoingMessageQueue'

describe('OutgoingMessageQueue', () => {
    it('drains enqueued messages', async () => {
        const sent: unknown[] = []
        const queue = new OutgoingMessageQueue((message) => {
            sent.push(message)
        })

        queue.enqueue({ type: 'assistant', message: 'one' })
        queue.enqueue({ type: 'assistant', message: 'two' })

        const drained = await queue.waitForDrain(1_000)

        expect(drained).toBe(true)
        expect(sent).toHaveLength(2)
    })

    it('waitForDrain times out when queue is blocked by delay', async () => {
        const sent: unknown[] = []
        const queue = new OutgoingMessageQueue((message) => {
            sent.push(message)
        })

        queue.enqueue({ type: 'assistant', message: 'tool call' }, { delay: 1_000 })

        const drained = await queue.waitForDrain(10)

        expect(drained).toBe(false)
        expect(sent).toHaveLength(0)
    })

    it('still drains after lock contention', async () => {
        const sent: unknown[] = []
        const queue = new OutgoingMessageQueue((message) => {
            sent.push(message)
        })

        const internalLock = (queue as unknown as {
            lock: { inLock: <T>(fn: () => Promise<T> | T) => Promise<T> }
        }).lock

        const blocker = internalLock.inLock(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 10))
        })

        queue.enqueue({ type: 'assistant', message: 'delayed-by-lock' })

        await blocker

        const drained = await queue.waitForDrain(1_000)

        expect(drained).toBe(true)
        expect(sent).toHaveLength(1)
    })
})
