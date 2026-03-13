import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import chalk from 'chalk'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { ApiClient } from '@/api/api'
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveMachineId(input: string): Promise<string> {
    if (UUID_RE.test(input)) {
        return input
    }

    // Treat as hostname or displayName — look up via API
    const api = await ApiClient.create()
    const machines = await api.listMachines()
    const matches = machines.filter(m =>
        m.metadata?.host === input || m.metadata?.displayName === input
    )

    if (matches.length === 0) {
        console.error(`No machine found matching "${input}"`)
        console.error('Available machines:')
        for (const m of machines) {
            const host = m.metadata?.host ?? 'unknown'
            const name = m.metadata?.displayName
            const label = name ? `${name} (${host})` : host
            console.error(`  ${m.id}  ${label}`)
        }
        process.exit(1)
    }

    if (matches.length > 1) {
        console.error(`Multiple machines match "${input}":`)
        for (const m of matches) {
            const host = m.metadata?.host ?? 'unknown'
            console.error(`  ${m.id}  ${host}`)
        }
        console.error('Please use the machine ID directly.')
        process.exit(1)
    }

    return matches[0].id
}

function parseTarget(target: string): { host?: string; port: number } {
    // host:port format (e.g. "192.168.1.100:22" or "example.com:80")
    const lastColon = target.lastIndexOf(':')
    if (lastColon > 0) {
        const portPart = target.slice(lastColon + 1)
        const hostPart = target.slice(0, lastColon)
        const port = parseInt(portPart, 10)
        if (Number.isFinite(port) && port > 0 && port <= 65535 && hostPart.length > 0) {
            return { host: hostPart, port }
        }
    }
    // Plain port number
    const port = parseInt(target, 10)
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
        return { port }
    }
    console.error(`Invalid target "${target}". Use <port> or <host:port>`)
    process.exit(1)
}

function buildTunnelWsUrl(tunnelId: string, token: string, role: 'connect' | 'runner'): string {
    const base = configuration.apiUrl.replace(/^http/, 'ws')
    return `${base}/tunnel/ws/${tunnelId}?token=${encodeURIComponent(token)}&role=${role}`
}

function startWsDataChannel(
    tunnelId: string,
    token: string,
    socket: Socket<TunnelServerEvents, TunnelClientEvents>,
    cleanup: () => void
): void {
    const wsUrl = buildTunnelWsUrl(tunnelId, token, 'connect')
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    let wsOpen = false
    let fallback = false

    const fallbackTimer = setTimeout(() => {
        if (!wsOpen && !fallback) {
            // WebSocket didn't connect in time, fall back to Socket.IO
            fallback = true
            startSocketIoDataChannel(tunnelId, socket, cleanup)
        }
    }, 3000)

    ws.addEventListener('open', () => {
        wsOpen = true
        clearTimeout(fallbackTimer)

        process.stdin.on('data', (chunk: Buffer) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk)
            }
        })

        process.stdin.on('end', () => {
            ws.close()
            socket.emit('tunnel:close', { tunnelId })
            cleanup()
        })

        process.stdin.resume()
    })

    ws.addEventListener('message', (event) => {
        process.stdout.write(Buffer.from(event.data as ArrayBuffer))
    })

    ws.addEventListener('close', () => {
        if (!fallback) cleanup()
    })

    ws.addEventListener('error', () => {
        if (!wsOpen && !fallback) {
            // WebSocket failed to connect, fall back to Socket.IO
            fallback = true
            clearTimeout(fallbackTimer)
            startSocketIoDataChannel(tunnelId, socket, cleanup)
        }
    })
}

function startSocketIoDataChannel(
    tunnelId: string,
    socket: Socket<TunnelServerEvents, TunnelClientEvents>,
    cleanup: () => void
): void {
    process.stdin.on('data', (chunk: Buffer) => {
        socket.emit('tunnel:data', { tunnelId, data: chunk.toString('base64') })
    })

    process.stdin.on('end', () => {
        socket.emit('tunnel:close', { tunnelId })
        cleanup()
    })

    process.stdin.resume()
}

async function handleConnectCommand(args: string[]): Promise<void> {
    const machineArg = args[0]
    const targetStr = args[1]

    if (!machineArg || !targetStr) {
        console.error('Usage: hapi connect <machineId|hostname> <port|host:port>')
        process.exit(1)
    }

    const { host, port } = parseTarget(targetStr)

    await initializeToken()
    const machineId = await resolveMachineId(machineArg)
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
        socket.emit('tunnel:request', { tunnelId, machineId, port, ...(host ? { host } : {}) })
    })

    socket.on('tunnel:ready', () => {
        startWsDataChannel(tunnelId, token, socket, cleanup)
    })

    socket.on('tunnel:data', (payload) => {
        // Socket.IO fallback path — only receives data if WebSocket upgrade failed
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
