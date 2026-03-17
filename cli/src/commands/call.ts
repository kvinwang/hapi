import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import chalk from 'chalk'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { initializeToken } from '@/ui/tokenInit'
import { ApiClient } from '@/api/api'
import type { CommandDefinition } from './types'

// ── Types ──────────────────────────────────────────────────────────

interface TunnelServerEvents {
    'tunnel:ready': (data: { tunnelId: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'tunnel:error': (data: { tunnelId: string; message: string }) => void
    error: (data: { message: string; code?: string }) => void
}

interface TunnelClientEvents {
    'tunnel:request': (data: { tunnelId: string; machineId: string; port: number }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
}

// ── Machine resolution ─────────────────────────────────────────────

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
        console.error(`Multiple machines match "${input}":`)
        for (const m of matches) {
            console.error(`  ${m.id}  ${m.metadata?.displayName ?? m.metadata?.host ?? 'unknown'}`)
        }
        process.exit(1)
    }
    return matches[0].id
}

// ── Tunnel NDJSON transport ────────────────────────────────────────

function openTunnel(machineId: string, token: string) {
    const tunnelId = randomUUID()
    let lineBuf = ''

    // Callback for each complete JSON response line
    let onResponse: ((line: string) => void) | null = null
    let onClose: (() => void) | null = null

    const socket: Socket<TunnelServerEvents, TunnelClientEvents> = io(
        `${configuration.apiUrl}/cli`,
        {
            transports: ['websocket'],
            auth: { token, clientType: 'tunnel' as const, machineId, capabilities: { wsTunnel: true } },
            path: '/socket.io/',
            reconnection: false,
        }
    )

    const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Tunnel setup timed out')), 15000)

        socket.on('connect', () => {
            socket.emit('tunnel:request', { tunnelId, machineId, port: 1 })
        })
        socket.on('tunnel:ready', () => { clearTimeout(timeout); resolve() })
        socket.on('tunnel:error', (p) => { clearTimeout(timeout); reject(new Error(p.message)) })
        socket.on('connect_error', (e) => { clearTimeout(timeout); reject(new Error(e.message)) })
        socket.on('error', (p) => { clearTimeout(timeout); reject(new Error(p.message)) })
    })

    socket.on('tunnel:data', (payload) => {
        if (payload.tunnelId !== tunnelId) return
        lineBuf += Buffer.from(payload.data, 'base64').toString('utf-8')
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop()!
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed && onResponse) onResponse(trimmed)
        }
    })

    socket.on('tunnel:close', () => { onClose?.() })
    socket.on('disconnect', () => { onClose?.() })

    function send(json: string): void {
        socket.emit('tunnel:data', { tunnelId, data: Buffer.from(json + '\n').toString('base64') })
    }

    function close(): void {
        socket.emit('tunnel:close', { tunnelId })
        socket.disconnect()
    }

    function setHandlers(handlers: { onResponse: (line: string) => void; onClose: () => void }): void {
        onResponse = handlers.onResponse
        onClose = handlers.onClose
    }

    return { ready, send, close, setHandlers }
}

// ── Arg parsing: --key value → {key: value}, positional → {_: [...]} ──

function parseCallArgs(argv: string[]): Record<string, unknown> | undefined {
    if (argv.length === 0) return undefined

    const named: Record<string, unknown> = {}
    const positional: string[] = []
    let hasNamed = false

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg.startsWith('--')) {
            hasNamed = true
            const eqIdx = arg.indexOf('=')
            if (eqIdx !== -1) {
                // --key=value
                const key = arg.slice(2, eqIdx)
                named[key] = coerce(arg.slice(eqIdx + 1))
            } else {
                // --key value
                const key = arg.slice(2)
                const val = argv[++i]
                named[key] = val !== undefined ? coerce(val) : true
            }
        } else {
            positional.push(arg)
        }
    }

    if (!hasNamed && positional.length === 0) return undefined
    if (!hasNamed) return { _: positional.length === 1 ? positional[0] : positional }

    const result = { ...named }
    if (positional.length > 0) {
        result._ = positional.length === 1 ? positional[0] : positional
    }
    return result
}

function coerce(v: string): unknown {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null') return null
    const n = Number(v)
    if (v !== '' && !isNaN(n) && isFinite(n)) return n
    return v
}

// ── Single call mode ───────────────────────────────────────────────

async function handleSingleCall(
    machineId: string,
    token: string,
    method: string,
    callArgs: string[]
): Promise<void> {
    const req: Record<string, unknown> = { method }
    const args = parseCallArgs(callArgs)
    if (args) req.args = args

    const tunnel = openTunnel(machineId, token)
    await tunnel.ready

    const response = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Request timed out')), 30000)
        tunnel.setHandlers({
            onResponse: (line) => { clearTimeout(timeout); resolve(line) },
            onClose: () => { clearTimeout(timeout); reject(new Error('Tunnel closed')) },
        })
        tunnel.send(JSON.stringify(req))
    })

    tunnel.close()
    process.stdout.write(response + '\n')

    try {
        const parsed = JSON.parse(response)
        process.exit(parsed.code ?? 0)
    } catch {
        process.exit(0)
    }
}

// ── Streaming mode (stdin → tunnel → stdout) ───────────────────────

async function handleStreaming(machineId: string, token: string): Promise<void> {
    const tunnel = openTunnel(machineId, token)
    await tunnel.ready

    tunnel.setHandlers({
        onResponse: (line) => { process.stdout.write(line + '\n') },
        onClose: () => { process.exit(0) },
    })

    // Read NDJSON from stdin, forward to tunnel
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => {
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed) tunnel.send(trimmed)
        }
    })

    process.stdin.on('end', () => {
        // Flush remaining
        if (buf.trim()) tunnel.send(buf.trim())
        // Give time for last response, then close
        setTimeout(() => {
            tunnel.close()
            process.exit(0)
        }, 1000)
    })

    process.stdin.resume()
}

// ── Entry point ────────────────────────────────────────────────────

async function handleCallCommand(args: string[]): Promise<void> {
    const machineArg = args[0]

    if (!machineArg) {
        console.error('Usage: hapi call <machine> <method> [--key value ...] [positional ...]')
        console.error('')
        console.error('Single call:')
        console.error('  hapi call Browser tabs')
        console.error('  hapi call Browser goto --url https://example.com')
        console.error('  hapi call Browser js --code "document.title"')
        console.error('  hapi call Browser query --selector "a.link"')
        console.error('  hapi call Browser wait --ms 1000')
        console.error('')
        console.error('Streaming NDJSON (stdin → tunnel → stdout):')
        console.error('  echo \'{"method":"tabs"}\' | hapi call Browser')
        console.error('  cat requests.jsonl | hapi call Browser')
        process.exit(1)
    }

    await initializeToken()
    const machineId = await resolveMachineId(machineArg)
    const token = getAuthToken()

    const method = args[1]

    if (method) {
        await handleSingleCall(machineId, token, method, args.slice(2))
    } else {
        await handleStreaming(machineId, token)
    }
}

export const callCommand: CommandDefinition = {
    name: 'call',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            await handleCallCommand(commandArgs)
            await new Promise(() => {})
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}
