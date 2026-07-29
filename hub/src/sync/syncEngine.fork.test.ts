import { afterEach, describe, expect, it } from 'bun:test'
import { Server } from 'socket.io'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SSEManager } from '../sse/sseManager'
import { Store } from '../store'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { SyncEngine } from './syncEngine'

const NAMESPACE = 'default'
const MACHINE_ID = 'machine-1'

const engines: SyncEngine[] = []

function makeEngine(): { engine: SyncEngine; store: Store } {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        new Server(),
        new RpcRegistry(),
        new SSEManager(0, new VisibilityTracker())
    )
    engines.push(engine)
    return { engine, store }
}

function makeSourceSession(engine: SyncEngine, store: Store, tag: string, messageCount = 5): string {
    const session = engine.createSession(
        tag,
        { path: '/tmp/project', host: 'test-host', machineId: MACHINE_ID, flavor: 'claude', claudeSessionId: 'claude-1' },
        NAMESPACE
    )
    for (let index = 0; index < messageCount; index += 1) {
        store.messages.addMessage(session.id, { role: 'user', content: `m${index}` })
    }
    return session.id
}

function bringMachineOnline(engine: SyncEngine): void {
    engine.getOrCreateMachine(MACHINE_ID, { host: 'test-host' }, null, NAMESPACE)
    engine.handleMachineAlive({ machineId: MACHINE_ID, time: Date.now() })
}

function countMessages(store: Store): number {
    return store.sessions
        .getSessions()
        .reduce((total, session) => total + store.messages.getMessages(session.id, 200).length, 0)
}

afterEach(() => {
    while (engines.length > 0) {
        engines.pop()?.stop()
    }
})

describe('SyncEngine.forkSession cleanup', () => {
    it('does not create a fork placeholder when the source machine is offline', async () => {
        const { engine, store } = makeEngine()
        const sourceId = makeSourceSession(engine, store, 'source-offline')
        const messagesBefore = countMessages(store)

        const result = await engine.forkSession(sourceId, 3, NAMESPACE)

        expect(result).toEqual({ type: 'error', message: 'No machine online', code: 'no_machine_online' })
        expect(engine.getSessionsByNamespace(NAMESPACE).map((session) => session.id)).toEqual([sourceId])
        expect(countMessages(store)).toBe(messagesBefore)
    })

    it('discards the fork placeholder when spawning on the target machine fails', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sourceId = makeSourceSession(engine, store, 'source-spawn-fails')
        const messagesBefore = countMessages(store)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'error', message: 'runner unreachable' })

        const result = await engine.forkSession(sourceId, 3, NAMESPACE)

        expect(result.type).toBe('error')
        expect(engine.getSessionsByNamespace(NAMESPACE).map((session) => session.id)).toEqual([sourceId])
        expect(countMessages(store)).toBe(messagesBefore)
    })

    it('discards the fork placeholder when the spawned session never becomes active', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sourceId = makeSourceSession(engine, store, 'source-never-active')
        const strandedId = engine.createSession('stranded', { path: '/tmp/project', host: 'test-host' }, NAMESPACE).id
        const messagesBefore = countMessages(store)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineAny = engine as any
        engineAny.rpcGateway.spawnSession = async () => ({ type: 'success', sessionId: strandedId })
        engineAny.waitForSessionActive = async () => false

        const result = await engine.forkSession(sourceId, 3, NAMESPACE)

        expect(result.type).toBe('error')
        expect(engine.getSessionsByNamespace(NAMESPACE).map((session) => session.id).sort())
            .toEqual([sourceId, strandedId].sort())
        expect(countMessages(store)).toBe(messagesBefore)
    })

    it('keeps a fork placeholder that a slow CLI has already claimed', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sourceId = makeSourceSession(engine, store, 'source-claimed')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineAny = engine as any
        let forkedId: string | undefined
        engineAny.rpcGateway.spawnSession = async () => {
            forkedId = engine
                .getSessionsByNamespace(NAMESPACE)
                .find((session) => session.id !== sourceId)?.id
            return { type: 'success', sessionId: forkedId! }
        }
        engineAny.waitForSessionActive = async () => false

        const result = await engine.forkSession(sourceId, 3, NAMESPACE)

        expect(result.type).toBe('error')
        expect(engine.getSession(forkedId!)).toBeDefined()
    })
})
