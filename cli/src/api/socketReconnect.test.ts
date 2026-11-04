import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { io } from 'socket.io-client'
import { retrySocketAuthentication } from './socketReconnect'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('retrySocketAuthentication', () => {
    it('keeps retrying middleware rejection without duplicate timers', async () => {
        const socket = io('http://127.0.0.1:1', { autoConnect: false })
        const connect = vi.spyOn(socket, 'connect').mockReturnValue(socket)
        const stop = retrySocketAuthentication(socket)
        try {
            socket.listeners('connect_error').forEach(listener => listener(new Error('Invalid token')))
            socket.listeners('connect_error').forEach(listener => listener(new Error('Invalid token')))
            await vi.advanceTimersByTimeAsync(5_000)
            expect(connect).toHaveBeenCalledTimes(1)
            socket.listeners('connect_error').forEach(listener => listener(new Error('Invalid token')))
            await vi.advanceTimersByTimeAsync(5_000)
            expect(connect).toHaveBeenCalledTimes(2)
        } finally {
            stop()
            socket.disconnect()
        }
    })

    it('cancels pending retries on successful connection and disposal', async () => {
        const socket = io('http://127.0.0.1:1', { autoConnect: false })
        const connect = vi.spyOn(socket, 'connect').mockReturnValue(socket)
        const stop = retrySocketAuthentication(socket)
        socket.listeners('connect_error').forEach(listener => listener(new Error('Invalid token')))
        socket.listeners('connect').forEach(listener => listener())
        await vi.advanceTimersByTimeAsync(5_000)
        expect(connect).not.toHaveBeenCalled()
        socket.listeners('connect_error').forEach(listener => listener(new Error('Invalid token')))
        stop()
        await vi.advanceTimersByTimeAsync(5_000)
        expect(connect).not.toHaveBeenCalled()
        socket.disconnect()
    })

    it('leaves active transport reconnection to Socket.IO', async () => {
        const socket = io('http://127.0.0.1:1', { autoConnect: false })
        const connect = vi.spyOn(socket, 'connect').mockReturnValue(socket)
        const active = vi.spyOn(socket, 'active', 'get').mockReturnValue(true)
        const stop = retrySocketAuthentication(socket)
        socket.listeners('connect_error').forEach(listener => listener(new Error('Transport error')))
        await vi.advanceTimersByTimeAsync(10_000)
        expect(connect).not.toHaveBeenCalled()
        stop()
        active.mockRestore()
        socket.disconnect()
    })

    it('does not retry intentional server disconnection', async () => {
        const socket = io('http://127.0.0.1:1', { autoConnect: false })
        const connect = vi.spyOn(socket, 'connect').mockReturnValue(socket)
        const stop = retrySocketAuthentication(socket)
        socket.listeners('disconnect').forEach(listener => listener('io server disconnect'))
        await vi.advanceTimersByTimeAsync(10_000)
        expect(connect).not.toHaveBeenCalled()
        stop()
        socket.disconnect()
    })
})
