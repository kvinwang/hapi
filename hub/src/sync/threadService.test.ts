import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Server } from 'socket.io'
import type { ThreadSender } from '@hapi/protocol/threads'
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
    const sender: ThreadSender = { kind: 'session', sessionId: a }
    const recipient: ThreadSender = { kind: 'session', sessionId: b }
    const thread = store.threads.create('default', 'test', '', sender)
    engine.threads.add(thread.id, 'default', recipient)
    const send = (text: string, mentions: string[] = [], clientMessageId = randomUUID(), from: ThreadSender = sender) => engine.threads.send(thread.id, 'default', from, { text, mentions, clientMessageId })
    return { store, engine, a, b, sender, recipient, thread, send }
}

describe('thread collaboration', () => {
    it('automatically notifies the only AI member without notifying itself or duplicating retries', async () => {
        const { engine, store, a, b, thread, send } = setup()
        store.threads.leave(thread.id, b)
        engine.handleSessionAlive({ sid: a, time: Date.now(), thinking: false })
        const requestId = randomUUID()
        const human = { kind: 'user' as const }
        const sent = await send('Please look at the discussion', [], requestId, human)
        expect(sent.message.mentions).toEqual([a])
        expect(sent.mentions[0].wakeStatus).toBe('woken')
        await send('Please look at the discussion', [], requestId, human)
        expect(store.messages.getMessages(a, 10)).toHaveLength(1)
        expect((await send('Working on it')).message.mentions).toEqual([])
        expect(store.messages.getMessages(a, 10)).toHaveLength(1)
    })

    it('counts all AI members and enables automatic notification only after the others leave', async () => {
        const { engine, store, a, b, thread, send } = setup()
        engine.handleSessionAlive({ sid: a, time: Date.now(), thinking: false })
        const human = { kind: 'user' as const }
        expect((await send('Two members, one inactive', [], randomUUID(), human)).message.mentions).toEqual([])
        store.threads.leave(thread.id, b)
        expect((await send('Now only one member', [], randomUUID(), human)).mentions[0].wakeStatus).toBe('woken')
    })

    it('queues single-member notifications while busy and respects mute and inactive state', async () => {
        const { engine, store, a, b, thread, send } = setup()
        store.threads.leave(thread.id, b)
        const human = { kind: 'user' as const }
        engine.handleSessionAlive({ sid: a, time: Date.now(), thinking: true })
        expect((await send('First', [], randomUUID(), human)).mentions[0]).toMatchObject({ wakeStatus: 'queued', reason: 'busy' })
        await send('Second', [], randomUUID(), human)
        engine.forceSessionIdle(a)
        await engine.threads.flush()
        expect(store.messages.getMessages(a, 10)).toHaveLength(1)
        store.threads.settings(thread.id, a, false)
        expect((await send('Muted', [], randomUUID(), human)).mentions[0].reason).toBe('muted')
        engine.handleSessionEnd({ sid: a, time: Date.now() })
        expect((await send('Stopped', [], randomUUID(), human)).mentions[0].reason).toBe('inactive')
        expect(store.messages.getMessages(a, 10)).toHaveLength(1)
    })

    it('notifies a replied-to agent once, while respecting mute and inactive state', async () => {
        const { engine, store, a, b, thread, send, recipient } = setup()
        const original = await send('Implementation ready')
        engine.handleSessionAlive({ sid: a, time: Date.now(), thinking: false })
        const input = { text: 'Please revise', mentions: [a], replyTo: original.message.id, clientMessageId: randomUUID() }
        const response = await engine.threads.send(thread.id, 'default', recipient, input)
        expect(response.message.mentions).toEqual([a])
        expect(response.mentions[0].wakeStatus).toBe('woken')
        await engine.threads.send(thread.id, 'default', recipient, input)
        expect(store.messages.getMessages(a, 10)).toHaveLength(1)
        store.threads.settings(thread.id, a, false)
        const muted = await engine.threads.send(thread.id, 'default', { kind: 'user' }, { ...input, mentions: [], clientMessageId: randomUUID() })
        expect(muted.mentions[0].reason).toBe('muted')
        engine.handleSessionEnd({ sid: a, time: Date.now() })
        const inactive = await engine.threads.send(thread.id, 'default', recipient, { ...input, mentions: [], clientMessageId: randomUUID() })
        expect(inactive.mentions[0].reason).toBe('inactive')
        const self = await engine.threads.send(thread.id, 'default', { kind: 'session', sessionId: a }, { ...input, mentions: [], clientMessageId: randomUUID() })
        expect(self.message.mentions).toEqual([])
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
    })

    it('adds no automatic mentions next to explicit ones, nor when auto-notify is off', async () => {
        const { engine, store, a, b, thread, send } = setup()
        const human = { kind: 'user' as const }
        const original = await send('From a')
        const replied = await engine.threads.send(thread.id, 'default', human, { text: 'Reply, but address b', mentions: [b], replyTo: original.message.id, clientMessageId: randomUUID() })
        expect(replied.message.mentions).toEqual([b])
        store.threads.leave(thread.id, b)
        store.threads.setAutoNotify(thread.id, false)
        expect((await send('Quiet', [], randomUUID(), human)).message.mentions).toEqual([])
        store.threads.setAutoNotify(thread.id, true)
        expect((await send('Loud', [], randomUUID(), human)).message.mentions).toEqual([a])
    })

    it('coalesces worker replies into one coordinator wake and stops without acknowledgments', async () => {
        const { engine, store, a, thread, sender } = setup()
        engine.handleSessionAlive({ sid: a, time: Date.now(), thinking: true })
        const workers = Array.from({ length: 4 }, () => {
            const id = engine.createSession(randomUUID(), { path: '/tmp', host: 'worker' }, 'default').id
            engine.threads.add(thread.id, 'default', { kind: 'session', sessionId: id })
            engine.handleSessionAlive({ sid: id, time: Date.now(), thinking: false })
            return id
        })
        const assigned = await engine.threads.send(thread.id, 'default', sender, {
            text: 'Implement your assigned part and report a commit.', mentions: workers, clientMessageId: randomUUID()
        })
        expect(assigned.mentions.every(r => r.wakeStatus === 'woken')).toBe(true)
        for (const id of workers) {
            const actor: ThreadSender = { kind: 'session', sessionId: id }
            const inbox = await engine.threads.inbox('default', actor, { limit: 50, wait: 0 })
            engine.threads.consume('default', actor, inbox.messages.map(m => m.id))
            await engine.threads.send(thread.id, 'default', actor, { text: `Result: branch worker/${id}, commit abc123`, mentions: [a], clientMessageId: randomUUID() })
        }
        engine.forceSessionIdle(a)
        await engine.threads.flush()
        expect(store.messages.getMessages(a, 50)).toHaveLength(1)
        const inbox = await engine.threads.inbox('default', sender, { limit: 50, wait: 0 })
        expect(inbox.messages).toHaveLength(4)
        engine.threads.consume('default', sender, inbox.messages.map(m => m.id))
        await engine.threads.send(thread.id, 'default', sender, { text: 'Integrated results in PR #1.', mentions: [], clientMessageId: randomUUID() })
        await engine.threads.flush()
        expect(store.threads.pending()).toHaveLength(0)
    })

    it('does not repeat awareness notices for reading or sending your own messages', async () => {
        const { engine, store, a, b, recipient, thread, send } = setup()
        const before = engine.threads.contextSnapshot(a, 'default').revision
        const sent = await send('my own update')
        expect(engine.threads.contextSnapshot(a, 'default').revision).toBe(before)
        const incoming = engine.threads.contextSnapshot(b, 'default').revision
        engine.threads.consume('default', recipient, [sent.message.id])
        expect(engine.threads.contextSnapshot(b, 'default').revision).toBe(incoming)
        expect(engine.threads.context(b, 'default')).toContain('0 unread')
        store.threads.leave(thread.id, a)
        expect(engine.threads.context(a, 'default')).toBe('')
    })

    it('ordinary messages stay in the inbox; mentions wake without copying their body', async () => {
        const { engine, store, b, thread, send, recipient } = setup()
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: false })
        await send('ordinary')
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
        const sent = await send('private collaboration body', [b])
        expect(sent.mentions[0].wakeStatus).toBe('woken')
        const notifications = store.messages.getMessages(b, 10)
        expect(notifications).toHaveLength(1)
        expect(JSON.stringify(notifications)).not.toContain('private collaboration body')
        expect(JSON.stringify(notifications)).toContain('hapi thread inbox')
        const inbox = await engine.threads.inbox('default', recipient, { limit: 50, wait: 0 })
        expect(inbox.messages.map(m => m.text)).toEqual(['ordinary', 'private collaboration body'])
    })

    it('does not wake stopped or muted sessions, and validates membership', async () => {
        const { engine, store, b, thread, send } = setup()
        expect((await send('stopped', [b])).mentions[0]).toMatchObject({ wakeStatus: 'not-woken', reason: 'inactive' })
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: false })
        store.threads.settings(thread.id, b, false)
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
        await engine.threads.flush()
        expect(store.messages.getMessages(b, 10)).toHaveLength(1)
        expect(store.threads.message(first.message.id)!.receipts.find(r => r.memberId === b)?.wakeStatus).toBe('woken')
    })

    it('mention-only consumption does not skip ordinary unread messages', async () => {
        const { engine, store, b, send, recipient, thread } = setup()
        const ordinary = await send('ordinary')
        const mentioned = await send('mention', [b])
        const filtered = await engine.threads.inbox('default', recipient, { mentions: true, limit: 50, wait: 0 })
        expect(filtered.messages.map(m => m.id)).toEqual([mentioned.message.id])
        expect(store.threads.unread(thread.id, b)).toBe(2)
        engine.threads.consume('default', recipient, filtered.messages.map(m => m.id))
        const remaining = await engine.threads.inbox('default', recipient, { limit: 50, wait: 0 })
        expect(remaining.messages.map(m => m.id)).toEqual([ordinary.message.id])
    })

    it('keeps waking members however often they mention each other', async () => {
        const { engine, store, b, send } = setup()
        const start = Date.now()
        for (let i = 0; i < 30; i++) {
            // Past the coalescing window, so every mention wakes.
            setSystemTime(new Date(start + i * 10_000))
            engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: false })
            expect((await send(`round ${i}`, [b])).mentions[0]).toMatchObject({ wakeStatus: 'woken' })
        }
        setSystemTime()
        expect(store.messages.getMessages(b, 100)).toHaveLength(30)
    })

    it('waits without polling and resolves when a message arrives', async () => {
        const { engine, send, recipient } = setup()
        const waiting = engine.threads.inbox('default', recipient, { limit: 50, wait: 1 })
        await send('arrived')
        expect((await waiting).messages[0].text).toBe('arrived')
        const abort = new AbortController()
        const { engine: other, recipient: otherRecipient } = setup()
        const stopped = other.threads.inbox('default', otherRecipient, { limit: 50, wait: 60 }, abort.signal)
        abort.abort()
        expect((await stopped).messages).toHaveLength(0)
    })

    it('new members can read history; continuation inherits read state; unrelated sessions do not', async () => {
        const { engine, store, b, thread, send, recipient } = setup()
        const first = await send('already read')
        engine.threads.consume('default', recipient, [first.message.id])
        await send('unread')
        const next = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default').id
        expect(store.threads.list('default', next)).toHaveLength(0)
        store.threads.inherit(b, next, 'default')
        expect(store.threads.inbox('default', next, { limit: 50 }).messages.map(m => m.text)).toEqual(['unread'])
        const newcomer = engine.createSession(randomUUID(), { path: '/tmp', host: 'test' }, 'default').id
        engine.threads.add(thread.id, 'default', { kind: 'session', sessionId: newcomer })
        expect(store.threads.unread(thread.id, newcomer)).toBe(0)
        expect(store.threads.history(thread.id, 0, 999, 50)).toHaveLength(2)
    })

    it('archive or leaving cancels pending wakeups', async () => {
        const { engine, store, b, thread, send } = setup()
        engine.handleSessionAlive({ sid: b, time: Date.now(), thinking: true })
        await send('pending', [b])
        store.threads.archive(thread.id)
        engine.forceSessionIdle(b)
        await engine.threads.flush()
        expect(store.messages.getMessages(b, 10)).toHaveLength(0)
        await expect(send('late')).rejects.toThrow('archived')
    })
})
