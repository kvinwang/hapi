import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('OutgoingMessageQueue message filtering', () => {
    let sent: Array<Record<string, unknown>>
    let queue: OutgoingMessageQueue

    beforeEach(() => {
        sent = []
        queue = new OutgoingMessageQueue((msg) => { sent.push(msg as Record<string, unknown>) })
    })

    afterEach(() => {
        queue.destroy?.()
    })

    it('sends normal messages', async () => {
        queue.enqueue({ type: 'assistant', uuid: '1' })
        queue.enqueue({ type: 'user', uuid: '2' })
        await queue.waitForDrain(1_000)

        expect(sent).toHaveLength(2)
    })

    it('filters out system messages', async () => {
        queue.enqueue({ type: 'system', subtype: 'init', uuid: '1' })
        queue.enqueue({ type: 'assistant', uuid: '2' })
        await queue.waitForDrain(1_000)

        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ type: 'assistant' })
    })

    it('filters out isMeta messages', async () => {
        queue.enqueue({ type: 'user', isMeta: true, uuid: '1' })
        queue.enqueue({ type: 'assistant', uuid: '2' })
        await queue.waitForDrain(1_000)

        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ type: 'assistant' })
    })

    it('filters out isCompactSummary messages', async () => {
        queue.enqueue({ type: 'assistant', isCompactSummary: true, uuid: '1' })
        queue.enqueue({ type: 'user', uuid: '2' })
        await queue.waitForDrain(1_000)

        expect(sent).toHaveLength(1)
        expect(sent[0]).toMatchObject({ type: 'user' })
    })
})
