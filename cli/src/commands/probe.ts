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
    if (UUID_RE.test(input)) return input
    const api = await ApiClient.create()
    const machines = await api.listMachines()
    const matches = machines.filter(m =>
        m.metadata?.host === input || m.metadata?.displayName === input
    )
    if (matches.length === 0) {
        console.error(`No machine found matching "${input}"`)
        process.exit(1)
    }
    if (matches.length > 1) {
        console.error(`Multiple machines match "${input}", use machine ID directly.`)
        process.exit(1)
    }
    return matches[0].id
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

async function handleProbeCommand(args: string[]): Promise<void> {
    const machineArg = args[0]
    if (!machineArg) {
        console.error('Usage: hapi probe <machineId|hostname>')
        process.exit(1)
    }

    await initializeToken()
    const machineId = await resolveMachineId(machineArg)
    const token = getAuthToken()
    const tunnelId = randomUUID()
    const port = 22 // probe uses SSH port by default

    console.log(chalk.bold('Tunnel probe'))
    console.log(`  hub:     ${configuration.apiUrl}`)
    console.log(`  machine: ${machineArg} (${machineId.slice(0, 8)}...)`)
    console.log()

    const socket: Socket<TunnelServerEvents, TunnelClientEvents> = io(
        `${configuration.apiUrl}/cli`,
        {
            transports: ['websocket'],
            auth: { token, clientType: 'tunnel' as const, machineId },
            path: '/socket.io/',
            reconnection: false
        }
    )

    const done = (code: number = 0) => {
        socket.disconnect()
        process.exit(code)
    }

    const startTime = Date.now()

    socket.on('connect', () => {
        const elapsed = Date.now() - startTime
        console.log(chalk.green('  ✓') + ` Socket.IO connected (${elapsed}ms)`)
        socket.emit('tunnel:request', { tunnelId, machineId, port })
    })

    socket.on('tunnel:ready', async () => {
        const elapsed = Date.now() - startTime
        console.log(chalk.green('  ✓') + ` Tunnel ready (${elapsed}ms)`)

        // Try WebSocket upgrade for connect side
        const wsUrl = `${configuration.apiUrl.replace(/^http/, 'ws')}/tunnel/ws/${tunnelId}?token=${encodeURIComponent(token)}&role=connect`
        const ws = new WebSocket(wsUrl)
        ws.binaryType = 'arraybuffer'

        let connectProto = 'socketio base64'

        const wsTimeout = setTimeout(() => {
            connectProto = 'socketio base64 (ws timeout)'
            ws.close()
            reportAndExit()
        }, 3000)

        ws.addEventListener('open', () => {
            clearTimeout(wsTimeout)
            connectProto = 'websocket binary'
            ws.close()
            reportAndExit()
        })

        ws.addEventListener('error', () => {
            clearTimeout(wsTimeout)
            connectProto = 'socketio base64 (ws unavailable)'
            reportAndExit()
        })

        async function reportAndExit() {
            const label = (p: string) => {
                if (p === 'websocket') return chalk.green('websocket binary')
                if (p === 'socketio') return chalk.yellow('socketio base64')
                return p.includes('websocket') ? chalk.green(p) : chalk.yellow(p)
            }

            console.log()
            console.log(chalk.bold('Protocol'))
            console.log(`  connect: ${label(connectProto)}`)

            // Wait for runner to potentially upgrade, then query hub
            await new Promise(r => setTimeout(r, 2000))
            const info = await queryProtocol(tunnelId, token)
            if (info) {
                console.log(`  runner:  ${label(info.runner === 'websocket' ? 'websocket binary' : 'socketio base64')}`)
            } else {
                console.log(`  runner:  ${chalk.dim('unknown (hub does not support protocol query)')}`)
            }

            // Latency measurements
            console.log()
            console.log(chalk.bold('Latency'))

            // Hub RTT: Socket.IO ping to hub only
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

            // Tunnel RTT: measured by tunnel setup time (connect → hub → runner TCP → hub → connect)
            const connectTime = Date.now() - startTime
            const tunnelSetup = elapsed - hubAvg // subtract hub RTT to estimate true tunnel overhead
            console.log(`  tunnel RTT: ~${elapsed}ms ${chalk.dim(`(setup, includes ${hubAvg}ms hub RTT)`)}`)

            // Clean up tunnel
            socket.emit('tunnel:close', { tunnelId })
            console.log()
            const totalElapsed = Date.now() - startTime
            console.log(chalk.dim(`Done in ${totalElapsed}ms`))
            done(0)
        }
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

    // Timeout entire probe
    setTimeout(() => {
        console.log(chalk.red('  ✗') + ' Probe timed out after 15s')
        done(1)
    }, 15000)
}

export const probeCommand: CommandDefinition = {
    name: 'probe',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleProbeCommand(commandArgs)
            await new Promise(() => {})
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}
