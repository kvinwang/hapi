import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from 'socket.io'
import { io } from 'socket.io-client'
import { expect, it } from 'vitest'
import { retrySocketAuthentication } from './socketReconnect'

it('reconnects a real socket after repeated middleware rejection is resolved', async () => {
    const http = createServer()
    const server = new Server(http)
    let reject = true
    let attempts = 0
    server.use((_socket, next) => {
        attempts++
        next(reject ? new Error('Invalid token') : undefined)
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const client = io(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, {
        autoConnect: false, transports: ['websocket']
    })
    const stop = retrySocketAuthentication(client)
    try {
        const rejected = new Promise<void>(resolve => client.once('connect_error', () => resolve()))
        client.connect()
        await rejected
        expect(client.active).toBe(false)
        const secondRejection = new Promise<void>(resolve => client.once('connect_error', () => resolve()))
        await secondRejection
        reject = false
        await new Promise<void>(resolve => client.once('connect', resolve))
        expect(client.connected).toBe(true)
        expect(attempts).toBe(3)
    } finally {
        stop()
        client.disconnect()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
}, 15_000)
