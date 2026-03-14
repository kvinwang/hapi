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
    'tunnel:request': (data: { tunnelId: string; machineId: string; port: number; host?: string }) => void
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
        if (Number.isFinite(port) && port >= 0 && port <= 65535 && hostPart.length > 0) {
            return { host: hostPart, port }
        }
    }
    // Plain port number
    const port = parseInt(target, 10)
    if (Number.isFinite(port) && port >= 0 && port <= 65535) {
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
        if (!fallback) {
            // WS closed unexpectedly — fall back to Socket.IO instead of exiting
            fallback = true
            clearTimeout(fallbackTimer)
            startSocketIoDataChannel(tunnelId, socket, cleanup)
        }
    })

    ws.addEventListener('error', () => {
        if (!wsOpen && !fallback) {
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

async function queryProtocol(tunnelId: string, token: string): Promise<{ connect: string; runner: string } | null> {
    try {
        const url = `${configuration.apiUrl}/tunnel/protocol/${tunnelId}?token=${encodeURIComponent(token)}`
        const res = await fetch(url)
        if (!res.ok) return null
        return await res.json() as { connect: string; runner: string }
    } catch {
        return null
    }
}

async function handleProbe(
    machineArg: string,
    port: number,
    host: string | undefined,
    machineId: string,
    token: string
): Promise<void> {
    const tunnelId = randomUUID()
    const startTime = Date.now()

    console.log(chalk.bold('Tunnel probe'))
    console.log(`  hub:     ${configuration.apiUrl}`)
    console.log(`  machine: ${machineArg} (${machineId.slice(0, 8)}...)`)
    console.log(`  target:  ${host ? `${host}:` : ''}${port}`)
    console.log()

    const socket: Socket<TunnelServerEvents, TunnelClientEvents> = io(
        `${configuration.apiUrl}/cli`,
        {
            transports: ['websocket'],
            auth: { token, clientType: 'tunnel' as const, machineId, capabilities: { wsTunnel: true } },
            path: '/socket.io/',
            reconnection: false
        }
    )

    const done = (code: number = 0) => {
        socket.disconnect()
        process.exit(code)
    }

    socket.on('connect', () => {
        const elapsed = Date.now() - startTime
        console.log(chalk.green('  ✓') + ` Socket.IO connected (${elapsed}ms)`)
        socket.emit('tunnel:request', { tunnelId, machineId, port, ...(host ? { host } : {}) })
    })

    socket.on('tunnel:ready', async () => {
        const tunnelSetup = Date.now() - startTime
        console.log(chalk.green('  ✓') + ` Tunnel ready (${tunnelSetup}ms)`)

        const label = (p: string) =>
            p === 'websocket' ? chalk.green('websocket binary') : chalk.yellow('socketio base64')

        // Query declared capabilities from hub (instant, no WS upgrade test needed)
        console.log()
        console.log(chalk.bold('Protocol'))
        const info = await queryProtocol(tunnelId, token)
        if (info) {
            console.log(`  connect: ${label(info.connect)}`)
            console.log(`  runner:  ${label(info.runner)}`)
        } else {
            console.log(chalk.dim('  (hub does not support protocol query)'))
        }

        // Latency: hub RTT via Socket.IO ping
        console.log()
        console.log(chalk.bold('Latency'))
        const hubPings: number[] = []
        for (let i = 0; i < 3; i++) {
            const pt0 = performance.now()
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('timeout')), 5000)
                ;(socket as any).emit('ping', () => {
                    clearTimeout(timeout)
                    resolve()
                })
            }).catch(() => {})
            hubPings.push(Math.round(performance.now() - pt0))
        }
        const hubAvg = Math.round(hubPings.reduce((a, b) => a + b, 0) / hubPings.length)
        console.log(`  hub RTT:    ${hubPings.join('/')}ms (avg ${hubAvg}ms)`)
        console.log(`  tunnel RTT: ~${tunnelSetup}ms ${chalk.dim(`(setup, includes ${hubAvg}ms hub RTT)`)}`)

        // Cleanup
        socket.emit('tunnel:close', { tunnelId })
        console.log()
        console.log(chalk.dim(`Done in ${Date.now() - startTime}ms`))
        done(0)
    })

    socket.on('tunnel:error', (payload) => {
        if (payload.tunnelId === tunnelId) {
            console.log(chalk.red('  ✗') + ` ${payload.message}`)
        }
        done(1)
    })

    socket.on('connect_error', (error) => {
        console.log(chalk.red('  ✗') + ` Connection error: ${error.message}`)
        done(1)
    })

    socket.on('error', (payload) => {
        console.log(chalk.red('  ✗') + ` Socket error: ${payload.message}`)
        done(1)
    })

    setTimeout(() => {
        console.log(chalk.red('  ✗') + ' Probe timed out after 15s')
        done(1)
    }, 15000)
}

async function handleConnectCommand(args: string[]): Promise<void> {
    // Check for --probe flag
    const probeIndex = args.indexOf('--probe')
    const isProbe = probeIndex !== -1
    if (isProbe) args.splice(probeIndex, 1)

    const machineArg = args[0]
    const targetStr = args[1]

    if (!machineArg || (!targetStr && !isProbe)) {
        console.error(isProbe
            ? 'Usage: hapi connect --probe <machineId|hostname> [port|host:port]'
            : 'Usage: hapi connect <machineId|hostname> <port|host:port> [--probe]')
        process.exit(1)
    }

    const { host, port } = targetStr ? parseTarget(targetStr) : { host: undefined, port: 22 }

    await initializeToken()
    const machineId = await resolveMachineId(machineArg)
    const token = getAuthToken()

    if (isProbe) {
        return handleProbe(machineArg, port, host, machineId, token)
    }

    const tunnelId = randomUUID()

    const socket: Socket<TunnelServerEvents, TunnelClientEvents> = io(
        `${configuration.apiUrl}/cli`,
        {
            transports: ['websocket'],
            auth: {
                token,
                clientType: 'tunnel' as const,
                machineId,
                capabilities: { wsTunnel: true }
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
        // Socket.IO fallback path — receives data when hub relays via Socket.IO
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
