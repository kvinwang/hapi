import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'
import { Store } from '../../../store'
import { TunnelRelay } from '../../../web/tunnelRelay'
import { RpcRegistry } from '../../rpcRegistry'
import { RpcGateway } from '../../../sync/rpcGateway'
import { SessionConnections } from '../../sessionConnections'
import { TerminalRegistry } from '../../terminalRegistry'
import { TunnelRegistry } from '../../tunnelRegistry'
import type { CliSocketWithData } from '../../socketTypes'
import { registerCliHandlers } from './index'

function socketEvent(socket: Socket, event: string): Promise<unknown[]> {
    return new Promise((resolve) => socket.once(event, (...args: unknown[]) => resolve(args)))
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
})

async function setup() {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('handover', { path: '/tmp/test' }, null, 'default')
    const http = createServer()
    const io = new Server(http)
    const rpcRegistry = new RpcRegistry()
    const sessionConnections = new SessionConnections()
    const terminalRegistry = new TerminalRegistry({ idleTimeoutMs: 1000 })
    const tunnelRegistry = new TunnelRegistry({ idleTimeoutMs: 1000 })
    const tunnelRelay = new TunnelRelay(tunnelRegistry)
    const ended: string[] = []
    io.of('/cli').on('connection', (socket) => {
        socket.data.namespace = 'default'
        socket.data.permissions = ['admin']
        registerCliHandlers(socket as CliSocketWithData, {
            io, store, rpcRegistry, sessionConnections, terminalRegistry, tunnelRegistry, tunnelRelay,
            onSessionEnd: ({ sid }) => ended.push(sid)
        })
    })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const clients: Socket[] = []
    cleanups.push(async () => {
        clients.forEach((client) => client.disconnect())
        await new Promise<void>((resolve) => io.close(() => resolve()))
    })
    const open = async () => {
        const client = connect(`http://127.0.0.1:${address.port}/cli`, {
            auth: { sessionId: session.id, clientType: 'session-scoped' },
            transports: ['websocket'], reconnection: false, autoConnect: false
        })
        clients.push(client)
        const connected = socketEvent(client, 'connect')
        client.connect()
        await connected
        return client
    }
    return { io, store, session, rpcRegistry, sessionConnections, ended, open }
}

describe('session connection handover', () => {
    it('retires the old driver before delivering messages to its replacement', async () => {
        const { io, store, session, rpcRegistry, sessionConnections, ended, open } = await setup()
        const old = await open()
        const oldId = old.id!
        old.emit('rpc-register', { method: `${session.id}:killSession` })
        await old.emitWithAck('ping')
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).toBe(oldId)
        const stopping = socketEvent(old, 'rpc-request')
        const oldUpdates: unknown[] = []
        old.on('update', (update) => oldUpdates.push(update))
        const current = await open()
        const [request, acknowledge] = await stopping as [{ method: string }, (response: string) => void]
        expect(request.method).toBe(`${session.id}:killSession`)
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).toBeNull()
        expect(io.of('/cli').adapter.rooms.get(`session:${session.id}`)).toEqual(new Set([current.id!]))
        current.emit('rpc-register', { method: `${session.id}:killSession` })
        await current.emitWithAck('ping')

        // The old process may emit its final metadata and heartbeat while its stop RPC is pending.
        old.emit('session-end', { sid: session.id, time: Date.now() })
        old.emit('message', { sid: session.id, message: { role: 'agent', content: 'stale reply' } })
        old.emit('update-metadata', { sid: session.id, expectedVersion: session.metadataVersion, metadata: { lifecycleState: 'archived' } })
        old.emit('rpc-register', { method: `${session.id}:killSession` })
        const update = socketEvent(current, 'update')
        io.of('/cli').to(`session:${session.id}`).emit('update', { text: 'only the new driver' })
        expect((await update)[0]).toEqual({ text: 'only the new driver' })
        const disconnected = socketEvent(old, 'disconnect')
        acknowledge(JSON.stringify({ success: true }))
        await disconnected

        expect(oldUpdates).toEqual([])
        expect(ended).toEqual([])
        expect(store.messages.getMaxSeq(session.id)).toBe(0)
        expect(store.sessions.getSession(session.id)?.metadata).toEqual({ path: '/tmp/test' })
        expect(rpcRegistry.getSocketIdForMethod(`${session.id}:killSession`)).toBe(current.id!)
        expect(sessionConnections.isCurrent(session.id, current.id!)).toBe(true)
    })

    it('disconnects a replaced driver even when its stop handler fails', async () => {
        const { session, open } = await setup()
        const old = await open()
        old.on('rpc-request', (_request, acknowledge) => acknowledge(JSON.stringify({ error: 'Method not found' })))
        const disconnected = socketEvent(old, 'disconnect')
        const current = await open()
        expect((await disconnected)[0]).toBe('io server disconnect')
        expect(current.connected).toBe(true)
        current.emit('session-alive', { sid: session.id, time: Date.now(), thinking: false })
        await current.emitWithAck('ping')
    })

    it('reports a failed stop RPC instead of allowing a handover to proceed', async () => {
        const { io, rpcRegistry, session, open } = await setup()
        const client = await open()
        client.emit('rpc-register', { method: `${session.id}:killSession` })
        await client.emitWithAck('ping')
        client.on('rpc-request', (_request, acknowledge) => acknowledge(JSON.stringify({ error: 'Method not found' })))
        await expect(new RpcGateway(io, rpcRegistry).killSession(session.id)).rejects.toThrow('Method not found')
    })

})
