import { expect, it } from 'bun:test'
import { io as connect } from 'socket.io-client'
import { Store } from '../store'
import { AuthService } from '../auth/authService'
import { RevocationCache } from '../auth/revocationCache'
import { hashApiKey } from '../utils/apiKey'
import { createSocketServer } from './server'

it('disconnects a real CLI socket on key revocation and rejects reconnection without affecting another key', async () => {
    const store = new Store(':memory:')
    for (const id of ['a', 'b']) store.apiKeys.createApiKey({ id, name: id, namespace: 'default', permissions: ['admin'], keyHash: hashApiKey(`test-key-${id}`), keyPrefix: 'test' })
    const cache = new RevocationCache(store.accessTokens, store.apiKeys)
    const authService = new AuthService(store, cache, new Uint8Array(32), 'unused')
    const sockets = createSocketServer({ store, authService, corsOrigins: [] })
    const handler = sockets.engine.handler()
    const server = Bun.serve({ port: 0, ...handler })
    const clients = ['a', 'b'].map(id => connect(`http://127.0.0.1:${server.port}/cli`, { transports: ['websocket'], reconnection: false, auth: { token: `test-key-${id}` } }))
    const connected = (client: typeof clients[number]) => new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
    try {
        await Promise.all(clients.map(connected))
        const disconnected = new Promise<void>(resolve => clients[0].once('disconnect', () => resolve()))
        store.apiKeys.revokeApiKey('a')
        cache.revokeApiKey('a')
        await disconnected
        expect(clients[0].connected).toBe(false)
        expect(clients[1].connected).toBe(true)
        const rejected = new Promise<void>(resolve => clients[0].once('connect_error', () => resolve()))
        clients[0].connect()
        await rejected
        expect(clients[0].connected).toBe(false)
    } finally {
        clients.forEach(client => client.disconnect())
        sockets.io.close()
        server.stop(true)
    }
}, 10000)
