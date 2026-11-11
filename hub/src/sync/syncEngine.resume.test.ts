import { afterEach, expect, it, spyOn } from 'bun:test'
import { Server } from 'socket.io'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SSEManager } from '../sse/sseManager'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { RpcGateway } from './rpcGateway'
import { SyncEngine } from './syncEngine'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })

function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    engine.getOrCreateMachine('machine', { host: 'host' }, null, 'default')
    engine.handleMachineAlive({ machineId: 'machine', time: Date.now() })
    const session = engine.createSession('tag', {
        host: 'host', machineId: 'machine', path: '/tmp/project', flavor: 'codex', codexSessionId: 'thread'
    }, 'default')
    return { engine, session }
}

it('coalesces concurrent revives and asks the runner to stop the old process first', async () => {
    const { engine, session } = setup()
    let finish!: () => void
    const spawn = spyOn(RpcGateway.prototype, 'spawnSession').mockImplementation(async (...args) => {
        expect(args[15]).toBe(session.id)
        await new Promise<void>(resolve => { finish = resolve })
        return { type: 'success', sessionId: session.id }
    })
    const active = spyOn(engine, 'waitForSessionActive').mockResolvedValue(true)
    try {
        const first = engine.resumeSession(session.id, 'default')
        const second = engine.resumeSession(session.id, 'default')
        expect(spawn).toHaveBeenCalledTimes(1)
        finish()
        expect(await first).toEqual({ type: 'success', sessionId: session.id })
        expect(await second).toEqual(await first)
    } finally {
        spawn.mockRestore()
        active.mockRestore()
    }
})

it('clears failed in-flight revives so a later attempt can recover', async () => {
    const { engine, session } = setup()
    const spawn = spyOn(RpcGateway.prototype, 'spawnSession').mockResolvedValue({ type: 'error', message: 'existing agent failed to stop' })
    try {
        expect((await engine.resumeSession(session.id, 'default')).type).toBe('error')
        expect((await engine.resumeSession(session.id, 'default')).type).toBe('error')
        expect(spawn).toHaveBeenCalledTimes(2)
    } finally {
        spawn.mockRestore()
    }
})

it('starts a fresh agent into a never-started placeholder, but not into a session that lost its agent id', async () => {
    const { engine } = setup()
    const placeholder = engine.createSession('placeholder', { host: 'host', machineId: 'machine', path: '/tmp/project', flavor: 'claude' }, 'default')
    const crashed = engine.createSession('crashed', { host: 'host', machineId: 'machine', path: '/tmp/project', flavor: 'claude', startedBy: 'runner' }, 'default')
    const spawn = spyOn(RpcGateway.prototype, 'spawnSession').mockResolvedValue({ type: 'success', sessionId: placeholder.id })
    const active = spyOn(engine, 'waitForSessionActive').mockResolvedValue(true)
    try {
        expect(await engine.resumeSession(placeholder.id, 'default')).toEqual({ type: 'success', sessionId: placeholder.id })
        expect(spawn.mock.calls[0]?.[7]).toBeUndefined()
        expect(spawn.mock.calls[0]?.[10]).toBe('placeholder')
        expect((await engine.resumeSession(crashed.id, 'default')).type).toBe('error')
        expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
        spawn.mockRestore()
        active.mockRestore()
    }
})
