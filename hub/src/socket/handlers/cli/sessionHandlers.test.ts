import { describe, expect, it } from 'bun:test'
import type { Store, StoredSession } from '../../../store'
import { registerSessionHandlers } from './sessionHandlers'

type SocketHandler = (payload: unknown, callback?: (response: unknown) => void) => void

class FakeSocket {
    private readonly handlers = new Map<string, SocketHandler>()

    on(event: string, handler: SocketHandler): void {
        this.handlers.set(event, handler)
    }

    to(_room: string): { emit: (_event: string, _payload: unknown) => void } {
        return {
            emit: () => {}
        }
    }

    emitIncoming(event: string, payload: unknown): void {
        this.handlers.get(event)?.(payload)
    }
}

function createStoredSession(overrides: Partial<StoredSession> = {}): StoredSession {
    return {
        id: 'session-1',
        tag: null,
        parentSessionId: null,
        namespace: 'default',
        machineId: null,
        createdAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        todos: null,
        todosUpdatedAt: null,
        active: true,
        activeAt: 0,
        seq: 0,
        uiState: null,
        uiStateUpdatedAt: null,
        shareToken: null,
        teamState: null,
        teamStateUpdatedAt: null,
        ...overrides
    }
}

describe('registerSessionHandlers', () => {
    it('treats ready events as an idle state sync fallback', () => {
        const socket = new FakeSocket()
        const session = createStoredSession()
        const sessionAlivePayloads: Array<{ sid: string; time: number; thinking?: boolean }> = []

        const store = {
            messages: {
                addMessage: (_sid: string, content: unknown, localId?: string | null) => ({
                    id: 'message-1',
                    seq: 1,
                    createdAt: 123,
                    localId: localId ?? null,
                    content
                })
            },
            sessions: {
                setSessionTodos: () => false
            }
        } as unknown as Store

        registerSessionHandlers(socket as unknown as Parameters<typeof registerSessionHandlers>[0], {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session }),
            emitAccessError: () => {},
            onSessionAlive: (payload) => sessionAlivePayloads.push(payload),
            onWebappEvent: () => {}
        })

        socket.emitIncoming('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: {
                    id: 'event-1',
                    type: 'event',
                    data: {
                        type: 'ready'
                    }
                }
            }
        })

        expect(sessionAlivePayloads).toEqual([{
            sid: session.id,
            time: 123,
            thinking: false
        }])
    })
})
