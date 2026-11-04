import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Server } from 'socket.io'
import type { GroupSender } from '@hapi/protocol/groups'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { SyncEngine } from './syncEngine'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })
function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const a = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default').id
    const b = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default').id
    const sender: GroupSender = { kind: 'session', sessionId: a }
    const recipient: GroupSender = { kind: 'session', sessionId: b }
    const group = store.groups.create('default', 'test', '', sender)
    engine.groups.add(group.id, 'default', recipient)
    const send = (text: string, mentions: string[] = [], clientMessageId = randomUUID(), from: GroupSender = sender) => engine.groups.send(group.id, 'default', from, { text, mentions, clientMessageId })
    return { store, engine, a, b, sender, recipient, group, send }
}

describe('group collaboration', () => {
    it('coalesces worker replies into one coordinator wake and stops without acknowledgments', async () => {
        const { engine, store, a, group, sender } = setup()
        engine.handleSessionAlive({ sid: a, time: Date.now(), thinking: true })
        const workers = Array.from({ length: 4 }, () => {
            const id = engine.createSession(randomUUID(), { path: '/tmp', host: 'worker' }, 'default').id
            engine.groups.add(group.id, 'default', { kind: 'session', sessionId: id })
            engine.handleSessionAlive({ sid: id, time: Date.now(), thinking: false })
            return id
        })
        const assigned = await engine.groups.send(group.id, 'default', sender, {
            text: 'Implement your assigned part and report a commit.', mentions: workers, clientMessageId: randomUUID()
        })
        expect(assigned.mentions.every(r => r.wakeStatus === 'woken')).toBe(true)
        for (const id of workers) {
            const actor: GroupSender = { kind: 'session', sessionId: id }
            const inbox = await engine.groups.inbox('default', actor, { limit: 50, wait: 0 })
            engine.groups.consume('default', actor, inbox.messages.map(m => m.id))
            await engine.groups.send(group.id, 'default', actor, { text: `Result: branch worker/${id}, commit abc123`, mentions: [a], clientMessageId: randomUUID() })
        }
        engine.forceSessionIdle(a)
        await engine.groups.flush()
        expect(store.messages.getMessages(a, 50)).toHaveLength(1)
        const inbox = await engine.groups.inbox('default', sender, { limit: 50, wait: 0 })
        expect(inbox.messages).toHaveLength(4)
        engine.groups.consume('default', sender, inbox.messages.map(m => m.id))
        await engine.groups.send(group.id, 'default', sender, { text: 'Integrated results in PR #1.', mentions: [], clientMessageId: randomUUID() })
        await engine.groups.flush()
        expect(store.groups.pending()).toHaveLength(0)
        expect(store.groups.get(group.id, 'default')!.wakeCount).toBe(5)
    })

    it('does not repeat awareness notices for reading or sending your own messages', async () => {
        const { engine, store, a, b, recipient, group, send } = setup()
        const before = engine.groups.contextSnapshot(a, 'default').revision
        const sent = await send('my own update')
        expect(engine.groups.contextSnapshot(a, 'default').revision).toBe(before)
        const incoming = engine.groups.contextSnapshot(b, 'default').revision
        engine.groups.consume('default', recipient, [sent.message.id])
        expect(engine.groups.contextSnapshot(b, 'default').revision).toBe(incoming)
        expect(engine.groups.context(b, 'default')).toContain('0 unread')
        store.groups.leave(group.id, a)
        expect(engine.groups.context(a, 'default')).toBe('')
    })

    it('ordinary messages stay in the inbox; mentions wake without copying their body', async () => {
        const { engine, store, b, group, send, recipient } = setup()
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: false })
        await send('ordinary')
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
        const sent = await send('private collaboration body', [b])
        expect(sent.mentions[0].wakeStatus).toBe('woken')
        const notifications = store.messages.getMessages(b, 10)
        expect(notifications).toHaveLength(1)
        expect(JSON.stringify(notifications)).not.toContain('private collaboration body')
        expect(JSON.stringify(notifications)).toContain('hapi group inbox')
        const inbox = await engine.groups.inbox('default', recipient, { limit: 50, wait: 0 })
        expect(inbox.messages.map(m => m.text)).toEqual(['ordinary', 'private collaboration body'])
        expect(store.groups.get(group.id, 'default')!.wakeCount).toBe(1)
    })

    it('does not wake stopped or muted sessions, and validates membership', async () => {
        const { engine, store, b, group, send } = setup()
        expect((await send('stopped', [b])).mentions[0]).toMatchObject({ wakeStatus: 'not-woken', reason: 'inactive' })
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: false })
        store.groups.settings(group.id, b, false)
        expect((await send('muted', [b])).mentions[0]).toMatchObject({ reason: 'muted' })
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
        await expect(send('invalid', [randomUUID()])).rejects.toThrow('not a member')
    })

    it('coalesces busy mentions and deduplicates send retries', async () => {
        const { engine, store, b, send } = setup()
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: true })
        const requestId = randomUUID()
        const first = await send('first', [b], requestId)
        const retry = await send('first', [b], requestId)
        await send('second', [b])
        expect(first.message.id).toBe(retry.message.id)
        expect(first.mentions[0]).toMatchObject({ wakeStatus: 'queued', reason: 'busy' })
        engine.forceSessionIdle(b)
        await engine.groups.flush()
        expect(store.messages.getMessages(b, 10)).toHaveLength(1)
        expect(store.groups.message(first.message.id)!.receipts.find(r => r.memberId === b)?.wakeStatus).toBe('woken')
    })

    it('mention-only consumption does not skip ordinary unread messages', async () => {
        const { engine, store, b, send, recipient, group } = setup()
        const ordinary = await send('ordinary')
        const mentioned = await send('mention', [b])
        const filtered = await engine.groups.inbox('default', recipient, { mentions: true, limit: 50, wait: 0 })
        expect(filtered.messages.map(m => m.id)).toEqual([mentioned.message.id])
        expect(store.groups.unread(group.id, b)).toBe(2)
        engine.groups.consume('default', recipient, filtered.messages.map(m => m.id))
        const remaining = await engine.groups.inbox('default', recipient, { limit: 50, wait: 0 })
        expect(remaining.messages.map(m => m.id)).toEqual([ordinary.message.id])
    })

    it('enforces the group wake budget until a human speaks', async () => {
        const { engine, store, b, group, send } = setup()
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: false })
        for (let i = 0; i < group.wakeLimit; i++) expect(store.groups.reserveWake(group.id)).toBe(true)
        expect((await send('budget', [b])).mentions[0]).toMatchObject({ reason: 'budget' })
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
        const resumed = await send('human', [b], randomUUID(), { kind: 'user' })
        expect(resumed.mentions[0].wakeStatus).toBe('woken')
        expect(store.groups.get(group.id, 'default')!.wakeCount).toBe(1)
    })

    it('waits without polling and resolves when a message arrives', async () => {
        const { engine, send, recipient } = setup()
        const waiting = engine.groups.inbox('default', recipient, { limit: 50, wait: 1 })
        await send('arrived')
        expect((await waiting).messages[0].text).toBe('arrived')
        const abort = new AbortController()
        const { engine: other, recipient: otherRecipient } = setup()
        const stopped = other.groups.inbox('default', otherRecipient, { limit: 50, wait: 60 }, abort.signal)
        abort.abort()
        expect((await stopped).messages).toHaveLength(0)
    })

    it('new members can read history; continuation inherits read state; unrelated sessions do not', async () => {
        const { engine, store, b, group, send, recipient } = setup()
        const first = await send('already read')
        engine.groups.consume('default', recipient, [first.message.id])
        await send('unread')
        const next = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default').id
        expect(store.groups.list('default', next)).toHaveLength(0)
        store.groups.inherit(b, next, 'default')
        expect(store.groups.inbox('default', next, { limit: 50 }).messages.map(m => m.text)).toEqual(['unread'])
        const newcomer = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default').id
        engine.groups.add(group.id, 'default', { kind: 'session', sessionId: newcomer })
        expect(store.groups.unread(group.id, newcomer)).toBe(0)
        expect(store.groups.history(group.id, 0, 999, 50)).toHaveLength(2)
    })

    it('archive or leaving cancels pending wakeups', async () => {
        const { engine, store, b, group, send } = setup()
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: true })
        await send('pending', [b])
        store.groups.archive(group.id)
        engine.forceSessionIdle(b)
        await engine.groups.flush()
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
        await expect(send('late')).rejects.toThrow('archived')
    })
})
