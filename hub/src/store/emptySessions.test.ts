import { describe, expect, it } from 'bun:test'
import { Store } from './index'

/**
 * "Empty" has to mean something a reader can predict: the session never carried
 * a message. Anything running, shared, or holding children stays put — those
 * deletes would fail anyway, and a cleanup that reports failures is worse than
 * one that never offers them.
 */

function makeStore() {
    const store = new Store(':memory:')
    const create = (tag: string) => store.sessions.getOrCreateSession(tag, { path: '/tmp' }, null, 'default')
    return { store, create }
}

describe('empty sessions', () => {
    it('finds sessions with no messages at all', () => {
        const { store, create } = makeStore()
        const empty = create('empty')
        const used = create('used')
        store.messages.addMessage(used.id, { role: 'user', content: { type: 'text', text: 'hi' } })

        expect(store.sessions.getEmptySessionIds('default')).toEqual([empty.id])
    })

    it('leaves a shared session alone', () => {
        const { store, create } = makeStore()
        const shared = create('shared')
        store.sessions.setShareToken(shared.id, 'default', 'share-token')

        expect(store.sessions.getEmptySessionIds('default')).not.toContain(shared.id)
    })

    it('leaves a session that has children alone', () => {
        const { store, create } = makeStore()
        const parent = create('parent')
        const child = create('child')
        store.sessions.updateSessionParent(child.id, parent.id, 'default')

        const empty = store.sessions.getEmptySessionIds('default')
        expect(empty).toContain(child.id)
        expect(empty).not.toContain(parent.id)
    })

    it('stays inside its namespace', () => {
        const { store } = makeStore()
        const mine = store.sessions.getOrCreateSession('mine', { path: '/tmp' }, null, 'default')
        store.sessions.getOrCreateSession('theirs', { path: '/tmp' }, null, 'other')

        expect(store.sessions.getEmptySessionIds('default')).toEqual([mine.id])
    })
})
