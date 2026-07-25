import type { DecryptedMessage } from '@/types/api'

export type MessageIngestBatcher = {
    queue: (sessionId: string, message: DecryptedMessage) => void
    flush: () => void
    dispose: (flushPending?: boolean) => void
}

export function createMessageIngestBatcher(options: {
    delayMs: number
    onFlush: (sessionId: string, messages: DecryptedMessage[]) => void
}): MessageIngestBatcher {
    const pending = new Map<string, DecryptedMessage[]>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }
        const batches = [...pending.entries()]
        pending.clear()
        for (const [sessionId, messages] of batches) {
            options.onFlush(sessionId, messages)
        }
    }

    return {
        queue(sessionId, message) {
            const messages = pending.get(sessionId)
            if (messages) {
                messages.push(message)
            } else {
                pending.set(sessionId, [message])
            }
            if (timer === null) {
                timer = setTimeout(flush, options.delayMs)
            }
        },
        flush,
        dispose(flushPending = false) {
            if (flushPending) {
                flush()
                return
            }
            if (timer !== null) {
                clearTimeout(timer)
                timer = null
            }
            pending.clear()
        }
    }
}
