/**
 * HAPI Browser Runner — Background Service Worker
 *
 * Connects to the HAPI hub as a machine-scoped runner via Socket.IO,
 * handling tunnel:open on port 0 with an in-process command interpreter
 * instead of a TCP connection.
 */

import { io, type Socket } from 'socket.io-client'
import { handleRequest, type Request } from './handler'

// ── Types ──────────────────────────────────────────────────────────

interface RunnerConfig {
    hubUrl: string
    token: string
    machineId: string
    machineName: string
}

interface TunnelServerEvents {
    'hub:hello': (data: { capabilities?: { wsPool?: boolean } }) => void
    'replaced': (data: { reason?: string }) => void
    'tunnel:open': (data: { tunnelId: string; port: number; host?: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    error: (data: { message: string; code?: string }) => void
}

interface TunnelClientEvents {
    'tunnel:ready': (data: { tunnelId: string }) => void
    'tunnel:data': (data: { tunnelId: string; data: string }) => void
    'tunnel:close': (data: { tunnelId: string }) => void
    'tunnel:error': (data: { tunnelId: string; message: string }) => void
    'rpc-register': (data: { method: string }) => void
}

// ── State ──────────────────────────────────────────────────────────

let socket: Socket<TunnelServerEvents, TunnelClientEvents> | null = null
let config: RunnerConfig | null = null
// Each tunnel has a line buffer for accumulating partial NDJSON lines
const tunnels = new Map<string, { lineBuf: string }>()

// Keep service worker alive while connected
let keepAliveInterval: ReturnType<typeof setInterval> | null = null

function startKeepAlive(): void {
    if (keepAliveInterval) return
    // Send machine-alive heartbeat every 20s (hub expires after 45s)
    keepAliveInterval = setInterval(() => {
        if (socket?.connected && config) {
            ;(socket as any).emit('machine-alive', {
                machineId: config.machineId,
                time: Date.now(),
            })
        }
    }, 20000)
    // Send first heartbeat immediately
    if (socket?.connected && config) {
        ;(socket as any).emit('machine-alive', {
            machineId: config.machineId,
            time: Date.now(),
        })
    }
}

function stopKeepAlive(): void {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval)
        keepAliveInterval = null
    }
}

// ── Machine registration ───────────────────────────────────────────

async function registerMachine(cfg: RunnerConfig): Promise<void> {
    const url = `${cfg.hubUrl}/cli/machines`
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({
            id: cfg.machineId,
            metadata: {
                host: 'browser-extension',
                displayName: cfg.machineName,
                platform: 'browser',
                happyCliVersion: 'hapi-browser/0.1.0',
                homeDir: '/',
                happyHomeDir: '/',
                happyLibDir: '/',
            },
            runnerState: {
                status: 'running',
                startedAt: Date.now(),
            },
        }),
    })
    if (!res.ok) {
        const body = await res.text()
        throw new Error(`Failed to register machine: ${res.status} ${body}`)
    }
}

// ── Connection ─────────────────────────────────────────────────────

async function connect(cfg: RunnerConfig): Promise<void> {
    if (socket) {
        socket.disconnect()
    }
    config = cfg

    // Ensure machine exists in hub DB before connecting socket
    await registerMachine(cfg)
    console.log('[HAPI] Machine registered')

    socket = io(`${cfg.hubUrl}/cli`, {
        transports: ['websocket'],
        auth: {
            token: cfg.token,
            clientType: 'machine-scoped' as const,
            machineId: cfg.machineId,
            username: 'browser-extension',
            capabilities: {
                wsTunnel: false,  // No pool WS support — Socket.IO only
            },
        },
        path: '/socket.io/',
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
    })

    socket.on('connect', () => {
        console.log('[HAPI] Connected to hub')
        startKeepAlive()
        updateBadge('ON', '#4CAF50')

        // Register RPC methods
        socket!.emit('rpc-register', { method: `${cfg.machineId}:path-exists` })
    })

    socket.on('disconnect', (reason) => {
        console.log('[HAPI] Disconnected:', reason)
        stopKeepAlive()
        updateBadge('OFF', '#F44336')
        // Clean up all active tunnels
        for (const [tunnelId, interp] of tunnels) {
            tunnels.delete(tunnelId)
        }
    })

    socket.on('replaced', (data) => {
        console.warn('[HAPI] Replaced by another runner:', data.reason)
        updateBadge('ERR', '#FF9800')
        socket?.disconnect()
        socket = null
    })

    socket.on('error', (data) => {
        console.error('[HAPI] Socket error:', data.message)
    })

    // ── Tunnel handlers (NDJSON RPC) ─────────────────────────────

    function tunnelSend(tunnelId: string, obj: unknown): void {
        const json = JSON.stringify(obj) + '\n'
        const b64 = btoa(unescape(encodeURIComponent(json)))
        socket?.emit('tunnel:data', { tunnelId, data: b64 })
    }

    socket.on('tunnel:open', (data) => {
        const { tunnelId, port } = data
        console.log(`[HAPI] tunnel:open tunnelId=${tunnelId} port=${port}`)

        if (port !== 1) {
            socket!.emit('tunnel:error', {
                tunnelId,
                message: `Browser runner only supports port 1, got ${port}`,
            })
            return
        }

        tunnels.set(tunnelId, { lineBuf: '' })
        refreshBadge()
        socket!.emit('tunnel:ready', { tunnelId })
    })

    socket.on('tunnel:data', (data) => {
        const entry = tunnels.get(data.tunnelId)
        if (!entry) return

        const raw = decodeURIComponent(escape(atob(data.data)))
        const tunnelId = data.tunnelId

        // Accumulate into line buffer, process complete lines
        entry.lineBuf += raw
        const lines = entry.lineBuf.split('\n')
        entry.lineBuf = lines.pop()!  // keep incomplete last segment

        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            let req: Request
            try {
                req = JSON.parse(trimmed)
            } catch {
                tunnelSend(tunnelId, { code: 1, error: `Invalid JSON: ${trimmed}` })
                continue
            }

            handleRequest(req).then(resp => {
                tunnelSend(tunnelId, resp)
            })
        }
    })

    socket.on('tunnel:close', (data) => {
        console.log(`[HAPI] tunnel:close tunnelId=${data.tunnelId}`)
        tunnels.delete(data.tunnelId)
        refreshBadge()
    })

    // ── RPC handlers ───────────────────────────────────────────────

    socket.on('rpc-request', (data, callback) => {
        const method = data.method
        const scopedMethod = method.includes(':') ? method.split(':').slice(1).join(':') : method

        switch (scopedMethod) {
            case 'path-exists':
                callback(JSON.stringify({ exists: false }))
                break
            default:
                callback(JSON.stringify({ error: `Unknown method: ${scopedMethod}` }))
        }
    })
}

function disconnect(): void {
    if (socket) {
        socket.disconnect()
        socket = null
    }
    config = null
    stopKeepAlive()
    updateBadge('', '')
}

// ── Badge ──────────────────────────────────────────────────────────

function updateBadge(text: string, color: string): void {
    chrome.action.setBadgeText({ text })
    if (color) {
        chrome.action.setBadgeBackgroundColor({ color })
    }
}

function refreshBadge(): void {
    if (!socket?.connected) return
    if (tunnels.size > 0) {
        updateBadge(String(tunnels.size), '#FF9800')  // yellow when active tunnels
    } else {
        updateBadge('ON', '#4CAF50')  // green when idle
    }
}

// ── Storage & auto-connect ─────────────────────────────────────────

async function loadConfig(): Promise<RunnerConfig | null> {
    const data = await chrome.storage.local.get(['hubUrl', 'token', 'machineId', 'machineName'])
    if (data.hubUrl && data.token && data.machineId) {
        return {
            hubUrl: data.hubUrl,
            token: data.token,
            machineId: data.machineId,
            machineName: data.machineName || 'Browser',
        }
    }
    return null
}

// Auto-connect on startup
loadConfig().then(async cfg => {
    if (cfg) {
        await connect(cfg)
    } else {
        updateBadge('?', '#9E9E9E')
    }
})

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'connect') {
        const cfg: RunnerConfig = msg.config
        // Save to storage
        chrome.storage.local.set({
            hubUrl: cfg.hubUrl,
            token: cfg.token,
            machineId: cfg.machineId,
            machineName: cfg.machineName,
        })
        connect(cfg).then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: String(err) }))
        return true // async response
    } else if (msg.type === 'disconnect') {
        disconnect()
        sendResponse({ ok: true })
    } else if (msg.type === 'status') {
        sendResponse({
            connected: socket?.connected ?? false,
            config: config ? { hubUrl: config.hubUrl, machineId: config.machineId, machineName: config.machineName } : null,
            activeTunnels: tunnels.size,
        })
    }
    return true // Keep message channel open for async response
})
