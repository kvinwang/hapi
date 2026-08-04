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

function makeSession(engine: SyncEngine, store: Store, tag: string, metadata: Record<string, unknown> = {}): string {
    const session = engine.createSession(tag, {
        path: '/tmp/project',
        host: 'test-host',
        machineId: MACHINE_ID,
        flavor: 'claude',
        claudeSessionId: 'claude-thread-1',
        ...metadata
    }, NAMESPACE)
    for (let index = 0; index < 5; index += 1) {
        store.messages.addMessage(session.id, { role: 'user', content: `m${index}` })
    }
    return session.id
}

function bringMachineOnline(engine: SyncEngine): void {
    engine.getOrCreateMachine(MACHINE_ID, { host: 'test-host' }, null, NAMESPACE)
    engine.handleMachineAlive({ machineId: MACHINE_ID, time: Date.now() })
}

afterEach(() => {
    while (engines.length > 0) {
        engines.pop()?.stop()
    }
})

describe('SyncEngine.switchSessionAgent', () => {
    it('refuses to switch to the agent already driving', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sessionId = makeSession(engine, store, 'already-claude')

        const result = await engine.switchSessionAgent(sessionId, 'claude', NAMESPACE)

        expect(result).toEqual({
            type: 'error',
            message: 'Session already uses claude',
            code: 'already_target_flavor'
        })
    })

    it('allows re-selecting the current agent when the point is to reset its context', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sessionId = makeSession(engine, store, 'reset-claude')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(engine as any).rpcGateway.spawnSession = async () => ({ type: 'error', message: 'runner unreachable' })

        const result = await engine.switchSessionAgent(sessionId, 'claude', NAMESPACE, { resetContext: true })

        expect(result.type).toBe('error')
        // Got past the guard and as far as spawning, which is the point.
        expect(result.type === 'error' && result.code).toBe('switch_failed')
    })

    it('does not touch the session when no machine is online', async () => {
        const { engine, store } = makeEngine()
        const sessionId = makeSession(engine, store, 'offline')

        const result = await engine.switchSessionAgent(sessionId, 'codex', NAMESPACE)

        expect(result).toEqual({ type: 'error', message: 'No machine online', code: 'no_machine_online' })
        expect(store.sessions.getSession(sessionId)?.metadata).not.toHaveProperty('agentDrivers')
    })

    it('reports an unknown session rather than creating one', async () => {
        const { engine } = makeEngine()
        bringMachineOnline(engine)

        const result = await engine.switchSessionAgent('nope', 'codex', NAMESPACE)

        expect(result.type === 'error' && result.code).toBe('session_not_found')
    })

    it('resumes the incoming agent on its own transcript and tells it what it missed', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sessionId = makeSession(engine, store, 'round-trip', { codexSessionId: 'codex-thread-1' })

        const spawnCalls: Array<{ agent: string; resumeSessionId?: string }> = []
        const sentMessages: string[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineAny = engine as any
        engineAny.rpcGateway.spawnSession = async (
            _machineId: string,
            _directory: string,
            agent: string,
            _model: unknown,
            _yolo: unknown,
            _sessionType: unknown,
            _worktreeName: unknown,
            resumeSessionId?: string
        ) => {
            spawnCalls.push({ agent, resumeSessionId })
            return { type: 'success', sessionId }
        }
        engineAny.waitForSessionActive = async () => true
        engineAny.sendMessage = async (_id: string, message: { text: string }) => {
            sentMessages.push(message.text)
        }

        // Claude hands over to Codex, which has driven this session before.
        const first = await engine.switchSessionAgent(sessionId, 'codex', NAMESPACE)
        expect(first.type === 'success' && first.resumedTranscript).toBe(true)
        expect(spawnCalls[0]).toEqual({ agent: 'codex', resumeSessionId: 'codex-thread-1' })
        expect(sentMessages[0]).toContain('taking over')

        // Codex does some work, then hands back to Claude.
        store.messages.addMessage(sessionId, { role: 'user', content: 'codex turn' })
        store.sessions.updateSessionMetadata(
            sessionId,
            { ...store.sessions.getSession(sessionId)!.metadata as object, flavor: 'codex' },
            store.sessions.getSession(sessionId)!.metadataVersion,
            NAMESPACE,
            { touchUpdatedAt: false }
        )
        engineAny.sessionCache.refreshSession(sessionId)

        const second = await engine.switchSessionAgent(sessionId, 'claude', NAMESPACE)
        expect(second.type === 'success' && second.resumedTranscript).toBe(true)
        expect(spawnCalls[1]).toEqual({ agent: 'claude', resumeSessionId: 'claude-thread-1' })
        expect(sentMessages[1]).toContain('resuming this session')
        expect(sentMessages[1]).toContain('--after-seq')
    })

    it('starts the incoming agent cold when asked to reset its context', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sessionId = makeSession(engine, store, 'reset', { codexSessionId: 'codex-thread-1' })

        const spawnCalls: Array<{ resumeSessionId?: string }> = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineAny = engine as any
        engineAny.rpcGateway.spawnSession = async (
            _machineId: string,
            _directory: string,
            _agent: string,
            _model: unknown,
            _yolo: unknown,
            _sessionType: unknown,
            _worktreeName: unknown,
            resumeSessionId?: string
        ) => {
            spawnCalls.push({ resumeSessionId })
            return { type: 'success', sessionId }
        }
        engineAny.waitForSessionActive = async () => true
        engineAny.sendMessage = async () => {}

        const result = await engine.switchSessionAgent(sessionId, 'codex', NAMESPACE, { resetContext: true })

        expect(result.type === 'success' && result.resumedTranscript).toBe(false)
        expect(spawnCalls[0].resumeSessionId).toBeUndefined()
    })

    it('says nothing to a returning agent that missed no turns', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sessionId = makeSession(engine, store, 'nothing-missed', { codexSessionId: 'codex-thread-1' })

        const sentMessages: string[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineAny = engine as any
        engineAny.rpcGateway.spawnSession = async () => ({ type: 'success', sessionId })
        engineAny.waitForSessionActive = async () => true
        engineAny.sendMessage = async (_id: string, message: { text: string }) => {
            sentMessages.push(message.text)
        }

        // Hand to Codex and straight back with no turns in between.
        await engine.switchSessionAgent(sessionId, 'codex', NAMESPACE)
        store.sessions.updateSessionMetadata(
            sessionId,
            { ...store.sessions.getSession(sessionId)!.metadata as object, flavor: 'codex' },
            store.sessions.getSession(sessionId)!.metadataVersion,
            NAMESPACE,
            { touchUpdatedAt: false }
        )
        engineAny.sessionCache.refreshSession(sessionId)
        await engine.switchSessionAgent(sessionId, 'claude', NAMESPACE)

        expect(sentMessages).toHaveLength(1)
        expect(sentMessages[0]).toContain('taking over')
    })

    it('stays silent when the catch-up prompt is declined', async () => {
        const { engine, store } = makeEngine()
        bringMachineOnline(engine)
        const sessionId = makeSession(engine, store, 'quiet')

        const sentMessages: string[] = []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engineAny = engine as any
        engineAny.rpcGateway.spawnSession = async () => ({ type: 'success', sessionId })
        engineAny.waitForSessionActive = async () => true
        engineAny.sendMessage = async (_id: string, message: { text: string }) => {
            sentMessages.push(message.text)
        }

        await engine.switchSessionAgent(sessionId, 'codex', NAMESPACE, { injectCatchUpPrompt: false })

        expect(sentMessages).toEqual([])
    })
})
