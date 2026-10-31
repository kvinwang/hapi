import { MessageChannel } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isCurrentPagePrecached } from './service-worker-version'

beforeEach(() => vi.stubGlobal('MessageChannel', MessageChannel))
afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

function workerReply(matches: boolean): ServiceWorker {
    return {
        postMessage: vi.fn((_message, ports: MessagePort[]) => ports[0].postMessage(matches))
    } as unknown as ServiceWorker
}

describe('isCurrentPagePrecached', () => {
    it('recognizes a refreshed page already included in the waiting worker', async () => {
        const worker = workerReply(true)
        await expect(isCurrentPagePrecached(worker, ['https://example.test/assets/index-new.js'])).resolves.toBe(true)
        expect(worker.postMessage).toHaveBeenCalledWith({
            type: 'CHECK_PAGE_ASSETS', assetUrls: ['https://example.test/assets/index-new.js']
        }, expect.any(Array))
    })

    it('keeps the update prompt for an older page', async () => {
        await expect(isCurrentPagePrecached(workerReply(false), ['https://example.test/assets/index-old.js'])).resolves.toBe(false)
    })

    it('falls back to the prompt when an older worker does not support the query', async () => {
        vi.useFakeTimers()
        const worker = { postMessage: vi.fn() } as unknown as ServiceWorker
        const result = isCurrentPagePrecached(worker, ['https://example.test/assets/index.js'])
        await vi.advanceTimersByTimeAsync(1500)
        await expect(result).resolves.toBe(false)
    })

    it('falls back when the waiting worker has become redundant', async () => {
        const worker = { postMessage: () => { throw new Error('Worker is redundant') } } as unknown as ServiceWorker
        await expect(isCurrentPagePrecached(worker, ['https://example.test/assets/index.js'])).resolves.toBe(false)
    })
})
