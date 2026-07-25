import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { createMessageIngestBatcher } from './message-ingest-batcher'

function message(id: string): DecryptedMessage {
    return { id } as DecryptedMessage
}

describe('message ingest batcher', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('flushes one ordered batch per session within the time window', () => {
        vi.useFakeTimers()
        const onFlush = vi.fn()
        const batcher = createMessageIngestBatcher({ delayMs: 16, onFlush })

        batcher.queue('a', message('a1'))
        batcher.queue('b', message('b1'))
        batcher.queue('a', message('a2'))
        vi.advanceTimersByTime(15)
        expect(onFlush).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(onFlush).toHaveBeenNthCalledWith(1, 'a', [message('a1'), message('a2')])
        expect(onFlush).toHaveBeenNthCalledWith(2, 'b', [message('b1')])
    })

    it('flushes pending messages during effect cleanup', () => {
        vi.useFakeTimers()
        const onFlush = vi.fn()
        const batcher = createMessageIngestBatcher({ delayMs: 16, onFlush })
        batcher.queue('a', message('a1'))

        batcher.dispose(true)

        expect(onFlush).toHaveBeenCalledOnce()
        vi.runAllTimers()
        expect(onFlush).toHaveBeenCalledOnce()
    })
})
