import { describe, expect, it } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { SessionActivitySummaries } from './sessionActivity'

describe('recent session activity', () => {
    it('falls back to the latest user message, ignores agent output and caches summaries by user sequence', async () => {
        const store = new Store(':memory:')
        const stored = store.sessions.getOrCreateSession('activity-test', { path: '/tmp' }, null, 'default')
        const session = { ...stored, active: true } as unknown as Session
        store.preferences.set('default', 'dashscopeApiKey', 'test-placeholder')
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Fix microphone capture' } })
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: '[语音·小精灵整理，可能有同音错字]\nKeep it automatic' } })
        let calls = 0
        const summaries = new SessionActivitySummaries(store, async (_key, messages) => {
            calls++
            expect(messages.map(m => m.text)).toEqual(['Fix microphone capture', 'Keep it automatic'])
            return 'Requests automatic microphone recovery'
        })
        expect(summaries.read(session)).toMatchObject({ text: 'Keep it automatic', source: 'message' })
        summaries.pump()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(summaries.read(session)).toMatchObject({ text: 'Requests automatic microphone recovery', source: 'summary' })
        store.messages.addMessage(session.id, { role: 'agent', content: { type: 'text', text: 'Working' } })
        summaries.read(session)
        expect(calls).toBe(1)
    })
    it('does not generate for closed sessions or missing provider configuration', () => {
        const store = new Store(':memory:')
        const stored = store.sessions.getOrCreateSession('fallback-test', { path: '/tmp' }, null, 'default')
        store.messages.addMessage(stored.id, { role: 'user', content: { type: 'text', text: 'Latest request' } })
        const session = { ...stored, active: false } as unknown as Session
        const summaries = new SessionActivitySummaries(store, async () => { throw new Error('Unexpected generation') })
        expect(summaries.read(session)?.text).toBe('Latest request')
        expect(summaries.read({ ...session, active: true })?.source).toBe('message')
    })
})

it('replaces an obsolete in-flight summary when a newer user message arrives', async () => {
    const store = new Store(':memory:')
    const stored = store.sessions.getOrCreateSession('inflight-test', { path: '/tmp' }, null, 'default')
    const session = { ...stored, active: true } as unknown as Session
    store.preferences.set('default', 'dashscopeApiKey', 'test-placeholder')
    store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'Old topic' } })
    let resolve!: (text: string) => void
    let calls = 0
    const summaries = new SessionActivitySummaries(store, async () => {
        calls++
        return calls === 1 ? new Promise<string>(done => { resolve = done }) : 'New topic summary'
    })
    summaries.read(session)
    summaries.pump()
    store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'New topic' } })
    expect(summaries.read(session)).toMatchObject({ text: 'New topic', source: 'message' })
    resolve('Obsolete summary')
    await new Promise(done => setTimeout(done, 0))
    expect(summaries.read(session)).toMatchObject({ text: 'New topic summary', source: 'summary' })
    expect(calls).toBe(2)
})
