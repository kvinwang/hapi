import { afterEach, expect, it } from 'bun:test'
import { Server } from 'socket.io'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SSEManager } from '../sse/sseManager'
import { Store } from '../store'
import { VisibilityTracker } from '../visibility/visibilityTracker'
import { SyncEngine } from './syncEngine'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })

it('takes a spawned session configuration from the request, not from its parent', async () => {
    const engine = new SyncEngine(new Store(':memory:'), new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    const parent = engine.createSession('parent', { path: '/tmp', host: 'host', flavor: 'codex', modelMode: 'clawdi/gpt-6-astra', permissionMode: 'yolo' }, 'default')
    const child = engine.createSession('child', { path: '/tmp', host: 'host', flavor: 'claude' }, 'default')
    const calls: unknown[][] = []
    const applied: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engineAny = engine as any
    engineAny.rpcGateway.spawnSession = async (...args: unknown[]) => {
        calls.push(args)
        return { type: 'success', sessionId: child.id }
    }
    engineAny.waitForSessionActive = async () => true
    engineAny.applySessionConfig = async (_id: string, config: unknown) => { applied.push(config) }

    expect(await engine.spawnSession('machine', '/tmp', 'claude', undefined, undefined, 'simple', undefined, undefined, parent.id)).toEqual({ type: 'success', sessionId: child.id })
    expect(calls[0][3]).toBeUndefined()
    expect(calls[0][4]).toBeUndefined()
    expect(calls[0][11]).toBe(parent.id)
    expect(applied).toEqual([])
})

function forkSetup(withCredential: boolean) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    engines.push(engine)
    engine.getOrCreateMachine('machine', { host: 'host' }, null, 'default')
    engine.handleMachineAlive({ machineId: 'machine', time: Date.now() })
    if (withCredential) store.credentials.createCredential({
        id: 'cred', namespace: 'default', name: 'Clawdi',
        config: { provider: 'clawdi', apiKey: 'k', endpoints: { 'anthropic-messages': 'https://example.test' }, models: [{ id: 'clawdi/model' }], defaultModel: 'clawdi/model' }
    })
    const source = engine.createSession('source', {
        path: '/tmp', host: 'host', machineId: 'machine', flavor: 'claude', claudeSessionId: 'claude-1',
        modelMode: 'clawdi/model', permissionMode: 'bypassPermissions',
        claudeProvider: { provider: { source: 'credential', credentialId: 'cred' }, name: 'Clawdi' }
    }, 'default')
    const target = engine.createSession('target', { path: '/tmp', host: 'host', flavor: 'claude' }, 'default')
    const calls: unknown[][] = []
    const applied: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engineAny = engine as any
    engineAny.rpcGateway.spawnSession = async (...args: unknown[]) => {
        calls.push(args)
        return { type: 'success', sessionId: target.id }
    }
    engineAny.waitForSessionActive = async () => true
    engineAny.sessionCache.mergeSessions = async () => {}
    engineAny.applySessionConfig = async (_id: string, config: unknown) => { applied.push(config) }
    return { engine, source, calls, applied }
}

it('forks on the source provider, model, and modes', async () => {
    const { engine, source, calls, applied } = forkSetup(true)
    expect(await engine.forkSession(source.id, 0, 'default')).toEqual({ type: 'success', sessionId: expect.any(String) })
    expect(calls[0][3]).toBe('clawdi/model')
    expect(calls[0][4]).toBe(true)
    expect(calls[0][12]).toMatchObject({ provider: 'clawdi' })
    expect(calls[0][14]).toBe('cred')
    expect(applied).toEqual([{ permissionMode: 'bypassPermissions', modelMode: 'clawdi/model' }])
})

it('refuses to fork onto a default provider when the source credential is gone', async () => {
    const { engine, source, calls } = forkSetup(false)
    expect(await engine.forkSession(source.id, 0, 'default')).toMatchObject({ type: 'error', message: 'Selected provider credential is no longer available' })
    expect(calls).toEqual([])
})
