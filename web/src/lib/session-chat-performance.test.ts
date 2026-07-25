import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureSessionChatStage, recordSessionChatDuration } from './session-chat-performance'

describe('session chat performance instrumentation', () => {
    beforeEach(() => {
        window.history.replaceState({}, '', '/?chatPerf=1')
        window.__HAPI_CHAT_PERF__?.reset()
    })

    afterEach(() => {
        window.history.replaceState({}, '', '/')
        delete window.__HAPI_CHAT_PERF__
    })

    it('records aggregate stage durations without retaining message data', () => {
        expect(measureSessionChatStage('reduce', () => 42)).toBe(42)
        recordSessionChatDuration('reduce', 5)

        const sample = window.__HAPI_CHAT_PERF__?.snapshot().reduce
        expect(sample?.count).toBe(2)
        expect(sample?.lastMs).toBe(5)
        expect(sample?.maxMs).toBeGreaterThanOrEqual(5)
        expect(Object.keys(sample ?? {})).toEqual(['count', 'totalMs', 'maxMs', 'lastMs'])
    })
})
