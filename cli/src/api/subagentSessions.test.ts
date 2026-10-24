import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@hapi/protocol/types'
import type { ApiClient } from './api'
import type { ApiSessionClient } from './apiSession'
import { SubagentSessions } from './subagentSessions'

function setup() {
    let metadata = { path: '/tmp', host: 'host' } as Metadata
    const writes: Metadata[] = []
    const client = {
        sessionId: 'owner',
        getMetadata: () => metadata,
        updateMetadata: (handler: (current: Metadata) => Metadata) => {
            const next = handler(metadata)
            if (next !== metadata) writes.push(next)
            metadata = next
        }
    } as unknown as ApiSessionClient
    const api = {
        getOrCreateSession: async () => ({ id: 'child', metadata: null, metadataVersion: 0 })
    } as unknown as ApiClient
    return { subagents: new SubagentSessions(api, client), writes, entry: () => metadata.subagents?.t1 }
}

describe('SubagentSessions progress throttle', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('writes the first step at once and coalesces the rest to the latest values', () => {
        const { subagents, writes, entry } = setup()
        subagents.start('t1', { description: 'task' })
        const afterStart = writes.length

        subagents.progress('t1', { activity: 'Read', toolUses: 1 })
        subagents.progress('t1', { activity: 'Edit', toolUses: 2 })
        subagents.progress('t1', { activity: 'Bash', toolUses: 3 })
        expect(writes.length).toBe(afterStart + 1)
        expect(entry()?.activity).toBe('Read')

        vi.advanceTimersByTime(1500)
        expect(writes.length).toBe(afterStart + 2)
        expect(entry()).toMatchObject({ activity: 'Bash', toolUses: 3 })

        vi.advanceTimersByTime(5000)
        expect(writes.length).toBe(afterStart + 2)
    })

    it('never loses the end state and drops pending progress after it', () => {
        const { subagents, writes, entry } = setup()
        subagents.start('t1', {})
        subagents.progress('t1', { activity: 'Read', toolUses: 1 })
        subagents.progress('t1', { activity: 'Edit', toolUses: 2 })
        subagents.end('t1', { status: 'completed', summary: 'done', toolUses: 2 })
        const count = writes.length

        vi.advanceTimersByTime(5000)
        expect(writes.length).toBe(count)
        expect(entry()).toMatchObject({ status: 'completed', summary: 'done', toolUses: 2 })
        expect(entry()?.activity).toBeUndefined()
    })
})
