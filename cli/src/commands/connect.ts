import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import chalk from 'chalk'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

interface TunnelServerEvents {
    'tunnel:ready': (data: { tunnelId: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'tunnel:error': (data: { tunnelId: string; message: string }) => void
    error: (data: { message: string; code?: string; scope?: string; id?: string }) => void
}

interface TunnelClientEvents {
    'tunnel:request': (data: { tunnelId: string; machineId: string; port: number }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
}

async function handleConnectCommand(args: string[]): Promise<void> {
    const machineId = args[0]
    const portStr = args[1]

    if (!machineId || !portStr) {
        console.error('Usage: hapi connect <machineId> <port>')
        process.exit(1)
    }

    const port = parseInt(portStr, 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        console.error('Invalid port number')
        process.exit(1)
    }

    await initializeToken()
    const token = getAuthToken()
    const tunnelId = randomUUID()

    const socket: Socket<TunnelServerEvents, TunnelClientEvents> = io(
        `${configuration.apiUrl}/cli`,
        {
            transports: ['websocket'],
            auth: {
                token,
                clientType: 'tunnel' as const,
                machineId
            },
            path: '/socket.io/',
            reconnection: false
        }
    )

    let exited = false
    const cleanup = () => {
        if (exited) return
        exited = true
        socket.disconnect()
        process.exit(0)
    }

    socket.on('connect', () => {
        socket.emit('tunnel:request', { tunnelId, machineId, port })
    })

    socket.on('tunnel:ready', () => {
        process.stdin.on('data', (chunk: Buffer) => {
            socket.emit('tunnel:data', { tunnelId, data: chunk.toString('base64') })
        })

        process.stdin.on('end', () => {
            socket.emit('tunnel:close', { tunnelId })
            cleanup()
        })

        process.stdin.resume()
    })

    socket.on('tunnel:data', (payload) => {
        if (payload.tunnelId !== tunnelId) return
        const buf = Buffer.from(payload.data, 'base64')
        process.stdout.write(buf)
    })

    socket.on('tunnel:close', () => {
        cleanup()
    })

    socket.on('tunnel:error', (payload) => {
        if (payload.tunnelId === tunnelId) {
            console.error(chalk.red(`Tunnel error: ${payload.message}`))
        }
        cleanup()
    })

    socket.on('connect_error', (error) => {
        console.error(chalk.red(`Connection error: ${error.message}`))
        process.exit(1)
    })

    socket.on('disconnect', () => {
        if (!exited) process.exit(1)
    })

    socket.on('error', (payload) => {
        console.error(chalk.red(`Socket error: ${payload.message}`))
        process.exit(1)
    })

    process.on('SIGINT', () => {
        socket.emit('tunnel:close', { tunnelId })
        cleanup()
    })

    process.on('SIGTERM', () => {
        socket.emit('tunnel:close', { tunnelId })
        cleanup()
    })
}

export const connectCommand: CommandDefinition = {
    name: 'connect',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleConnectCommand(commandArgs)
            // Keep process alive until tunnel closes
            await new Promise(() => {})
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}
