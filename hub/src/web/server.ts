import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { logger } from 'hono/logger'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { serveStatic } from 'hono/bun'
import { configuration } from '../configuration'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { SyncEngine } from '../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from './middleware/auth'
import { createAuthRoutes } from './routes/auth'
import { createBindRoutes } from './routes/bind'
import { createEventsRoutes } from './routes/events'
import { createSessionsRoutes } from './routes/sessions'
import { createMessagesRoutes } from './routes/messages'
import { createPermissionsRoutes } from './routes/permissions'
import { createCredentialsRoutes } from './routes/credentials'
import { createMachinesRoutes } from './routes/machines'
import { createGitRoutes } from './routes/git'
import { createCliRoutes } from './routes/cli'
import { createPushRoutes } from './routes/push'
import { createQrRoutes } from './routes/qr'
import { createShareRoutes } from './routes/share'
import { createSharePageRoutes } from './routes/sharePage'
import { createSyncRoutes } from './routes/sync'
import { createUsageRoutes } from './routes/usage'
import { createVoiceRoutes } from './routes/voice'
import { createApiKeyRoutes } from './routes/apiKeys'
import { createFileRoutes } from './routes/files'
import { createInviteRoutes } from './routes/invites'
import { createPreferencesRoutes } from './routes/preferences'
import { createModelPricingRoutes } from './routes/modelPricing'
import { createLobstearRoutes, type LobstearService } from '../lobstear'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { Server as BunServer, ServerWebSocket } from 'bun'
import type { Server as SocketEngine } from '@socket.io/bun-engine'
import type { WebSocketData } from '@socket.io/bun-engine'
import { type TunnelRelay, type TunnelWsData, type PoolWsData } from './tunnelRelay'
import type { TunnelRegistry } from '../socket/tunnelRegistry'
import type { AuthService as AuthServiceType } from '../auth/authService'
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'
import type { Store } from '../store'
import type { AuthService } from '../auth/authService'
import type { RevocationCache } from '../auth/revocationCache'

let cachedInstallScript: string | null = null
function getInstallScript(): string {
    if (cachedInstallScript) return cachedInstallScript
    // Try common locations relative to the executable/cwd
    for (const base of [join(__dirname, '..', '..', '..', '..'), join(__dirname, '..', '..', '..'), process.cwd(), configuration.dataDir]) {
        try {
            cachedInstallScript = readFileSync(join(base, 'install.sh'), 'utf-8')
            return cachedInstallScript
        } catch { /* try next */ }
    }
    // In compiled binary, install.sh may not be on disk — redirect to GitHub
    return ''
}

let cachedInstallPs1: string | null = null
function getInstallPs1(): string {
    if (cachedInstallPs1) return cachedInstallPs1
    for (const base of [join(__dirname, '..', '..', '..', '..'), join(__dirname, '..', '..', '..'), process.cwd(), configuration.dataDir]) {
        try {
            cachedInstallPs1 = readFileSync(join(base, 'install.ps1'), 'utf-8')
            return cachedInstallPs1
        } catch { /* try next */ }
    }
    return ''
}

function findWebappDistDir(): { distDir: string; indexHtmlPath: string } {
    const candidates = [
        join(process.cwd(), '..', 'web', 'dist'),
        join(import.meta.dir, '..', '..', '..', 'web', 'dist'),
        join(process.cwd(), 'web', 'dist')
    ]

    for (const distDir of candidates) {
        const indexHtmlPath = join(distDir, 'index.html')
        if (existsSync(indexHtmlPath)) {
            return { distDir, indexHtmlPath }
        }
    }

    const distDir = candidates[0]
    return { distDir, indexHtmlPath: join(distDir, 'index.html') }
}

// Content-hashed bundles under /assets/ never change, so they can be cached forever.
// Everything else (index.html, sw.js, the manifest, icons) keeps a stable URL across
// deploys and must be revalidated, otherwise a stale shell pins users to an old build.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const REVALIDATE_CACHE_CONTROL = 'no-cache'

function cacheControlForPath(urlPath: string): string {
    return urlPath.startsWith('/assets/') ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL
}

function serveEmbeddedAsset(asset: EmbeddedWebAsset): Response {
    return new Response(Bun.file(asset.sourcePath), {
        headers: {
            'Content-Type': asset.mimeType,
            'Cache-Control': cacheControlForPath(asset.path)
        }
    })
}

function serveWindowsBat(c: any, hubUrl: string, token?: string, display?: string, quick?: boolean): Response {
    const ghRelease = 'https://github.com/kvinwang/hapi/releases/latest/download'
    const filename = token ? 'hapi-join.bat' : 'hapi-install.bat'

    const bat = `@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo.
echo   HAPI${token ? ' - Remote Assist' : ' - Install'}
echo.

:: Defaults (injected by hub)
set "DEFAULT_API=${hubUrl}"
set "DEFAULT_TOKEN=${token ?? ''}"
set "DEFAULT_NAME=${display ?? ''}"

:: Auto-detect hostname if no display name
if "!DEFAULT_NAME!"=="" (
    for /f "delims=" %%h in ('hostname') do set "DEFAULT_NAME=%%h"
)

${quick ? `:: Quick mode — use defaults directly
set "HAPI_API_URL=!DEFAULT_API!"
set "CLI_API_TOKEN=!DEFAULT_TOKEN!"
set "HAPI_MACHINE_NAME=!DEFAULT_NAME!"` : `:: Interactive mode — prompt with defaults
set /p "HAPI_API_URL=API URL [!DEFAULT_API!]: " || set "HAPI_API_URL=!DEFAULT_API!"
set /p "CLI_API_TOKEN=Token [!DEFAULT_TOKEN!]: " || set "CLI_API_TOKEN=!DEFAULT_TOKEN!"
set /p "HAPI_MACHINE_NAME=Machine name [!DEFAULT_NAME!]: " || set "HAPI_MACHINE_NAME=!DEFAULT_NAME!"`}

if "!CLI_API_TOKEN!"=="" (
    echo [ERROR] Token is required.
    pause
    exit /b 1
)

:: Detect architecture
set "ARCH=x86_64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=aarch64"

set "TARGET=%ARCH%-pc-windows-msvc"
set "URL=${ghRelease}/happier-%TARGET%.zip"
set "TMPDIR=%TEMP%\\hapi-join-%RANDOM%"

echo.
echo [INFO] Platform: windows-%ARCH%
echo [INFO] Downloading happier...

mkdir "%TMPDIR%" 2>nul
curl -fsSL -o "%TMPDIR%\\happier.zip" "%URL%"
if errorlevel 1 (
    echo [ERROR] Download failed: %URL%
    pause
    exit /b 1
)

:: Extract
tar -xf "%TMPDIR%\\happier.zip" -C "%TMPDIR%" 2>nul || (
    powershell -c "Expand-Archive -Path '%TMPDIR%\\happier.zip' -DestinationPath '%TMPDIR%' -Force"
)

echo [INFO] Starting happier...
echo [INFO] Press Ctrl+C to disconnect.
echo.

"%TMPDIR%\\happier.exe"

:: Cleanup
rmdir /s /q "%TMPDIR%" 2>nul
pause
`
    return c.body(bat, 200, {
        'Content-Type': 'application/x-bat',
        'Content-Disposition': `attachment; filename="${filename}"`
    })
}

function createWebApp(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    store: Store
    authService: AuthService
    revocationCache: RevocationCache
    vapidPublicKey: string
    corsOrigins?: string[]
    embeddedAssetMap: Map<string, EmbeddedWebAsset> | null
    relayMode?: boolean
    officialWebUrl?: string
    lobstearService?: LobstearService | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('*', logger())

    // Health check endpoint (no auth required)
    app.get('/health', (c) => c.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION }))

    const corsOrigins = (options.corsOrigins ?? configuration.corsOrigins)
        .filter(o => o !== '*')
    if (corsOrigins.length > 0) {
        const corsMiddleware = cors({
            origin: corsOrigins,
            allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
            allowHeaders: ['authorization', 'content-type'],
            credentials: true,
        })
        app.use('/api/*', corsMiddleware)
        app.use('/cli/*', corsMiddleware)
    }

    // Unified install endpoint (public, no auth)
    // Query params (all optional, orthogonal):
    //   token=xxx    — set default token in script
    //   os=windows   — return .bat instead of shell script
    //   display=name — set default machine display name
    //   quick=1      — non-interactive mode (token required)
    app.get('/install', (c) => {
        const url = new URL(c.req.url)
        const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
        const hubUrl = `${proto}://${url.host}`
        const token = c.req.query('token')
        const display = c.req.query('display')
        const os = c.req.query('os')
        const quick = c.req.query('quick') === '1'

        if (quick && !token) {
            return c.text('quick=1 requires token parameter', 400)
        }

        if (os === 'browser') {
            // Redirect to latest browser extension zip from GitHub releases
            return c.redirect('https://github.com/kvinwang/hapi/releases/latest/download/hapi-browser-extension.zip', 302)
        }

        if (os === 'windows') {
            return serveWindowsBat(c, hubUrl, token, display, quick)
        }

        // Default: shell script
        const raw = getInstallScript()
        if (!raw) {
            return c.redirect('https://raw.githubusercontent.com/kvinwang/hapi/main/install.sh', 302)
        }
        const script = raw.replace('__HAPI_HUB_URL__', hubUrl)
        return c.text(script, 200, { 'Content-Type': 'text/x-shellscript' })
    })

    // Legacy PowerShell endpoint (still useful for full install)
    app.get('/install.ps1', (c) => {
        const raw = getInstallPs1()
        if (!raw) {
            return c.redirect('https://raw.githubusercontent.com/kvinwang/hapi/main/install.ps1', 302)
        }
        const url = new URL(c.req.url)
        const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')
        const hubUrl = `${proto}://${url.host}`
        const script = raw.replace('__HAPI_HUB_URL__', hubUrl)
        return c.text(script, 200, { 'Content-Type': 'text/plain' })
    })

    // 50MB body limit for CLI routes (file uploads are base64-encoded)
    app.use('/cli/*', bodyLimit({ maxSize: 50 * 1024 * 1024 }))

    const filesDir = join(configuration.dataDir, 'files')
    app.route('/cli', createCliRoutes(options.getSyncEngine, options.authService, filesDir))

    app.route('/api', createAuthRoutes(options.store, options.authService))
    app.route('/api', createBindRoutes(options.store, options.authService))
    app.route('/api', createQrRoutes(options.store, options.authService))
    app.route('/api', createShareRoutes(options.store))
    app.route('/api', createFileRoutes(filesDir, options.store, options.authService))

    // Server-rendered share page (markdown/JSON) — sits at the SPA path `/shared/:token`
    // and only intercepts when `fmt=md|json` is present; otherwise falls through to the SPA.
    app.route('/', createSharePageRoutes(options.store))


    app.use('/api/*', createAuthMiddleware(options.authService))
    app.route('/api', createApiKeyRoutes(options.store, options.authService, options.revocationCache))
    app.route('/api', createEventsRoutes(options.getSseManager, options.getSyncEngine, options.getVisibilityTracker))
    app.route('/api', createSessionsRoutes(options.getSyncEngine, options.store))
    app.route('/api', createMessagesRoutes(options.getSyncEngine))
    app.route('/api', createPermissionsRoutes(options.getSyncEngine))
    app.route('/api', createCredentialsRoutes(options.store, options.getSyncEngine))
    app.route('/api', createMachinesRoutes(options.getSyncEngine, options.store))
    app.route('/api', createUsageRoutes(options.getSyncEngine))
    app.route('/api', createGitRoutes(options.getSyncEngine))
    app.route('/api', createPushRoutes(options.store, options.vapidPublicKey))
    app.route('/api', createSyncRoutes(options.store))
    app.route('/api', createVoiceRoutes())
    app.route('/api', createPreferencesRoutes(options.store))
    app.route('/api', createModelPricingRoutes(options.store))
    app.route('/api', createInviteRoutes(options.store))
    if (options.lobstearService) {
        app.route('/api/lobstear', createLobstearRoutes(options.lobstearService))
    }

    // Skip static serving in relay mode, show helpful message on root
    if (options.relayMode) {
        const officialUrl = options.officialWebUrl || 'https://app.hapi.run'
        app.get('/', (c) => {
            return c.html(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>HAPI Hub</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 600px;">
<h1>HAPI Hub</h1>
<p>This hub is running in relay mode. Please use the official web app:</p>
<p><a href="${officialUrl}">${officialUrl}</a></p>
<details>
<summary>Why am I seeing this?</summary>
<p style="margin-top: 0.5rem; color: #666;">
When relay mode is enabled, all traffic flows through our relay infrastructure with end-to-end encryption.
To reduce bandwidth and improve performance, the frontend is served separately
from GitHub Pages instead of through the relay tunnel.
</p>
</details>
</body>
</html>`)
        })
        return app
    }

    if (options.embeddedAssetMap) {
        const embeddedAssetMap = options.embeddedAssetMap
        const indexHtmlAsset = embeddedAssetMap.get('/index.html')

        if (!indexHtmlAsset) {
            app.get('*', (c) => {
                return c.text(
                    'Embedded Mini App is missing index.html. Rebuild the executable after running bun run build:web.',
                    503
                )
            })
            return app
        }

        app.use('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                return await next()
            }

            if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
                return await next()
            }

            const asset = embeddedAssetMap.get(c.req.path)
            if (asset) {
                return serveEmbeddedAsset(asset)
            }

            return await next()
        })

        app.get('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                await next()
                return
            }

            return serveEmbeddedAsset(indexHtmlAsset)
        })

        return app
    }

    const { distDir, indexHtmlPath } = findWebappDistDir()

    if (!existsSync(indexHtmlPath)) {
        app.get('/', (c) => {
            return c.text(
                'Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n',
                503
            )
        })
        return app
    }

    const setStaticCacheHeaders = (_path: string, c: Context) => {
        c.header('Cache-Control', cacheControlForPath(c.req.path))
    }

    app.use('/assets/*', serveStatic({ root: distDir, onFound: setStaticCacheHeaders }))

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({ root: distDir, onFound: setStaticCacheHeaders })(c, next)
    })

    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({
            root: distDir,
            path: 'index.html',
            onFound: (_found, ctx) => { ctx.header('Cache-Control', REVALIDATE_CACHE_CONTROL) }
        })(c, next)
    })

    return app
}

export async function startWebServer(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    store: Store
    authService: AuthService
    revocationCache: RevocationCache
    vapidPublicKey: string
    socketEngine: SocketEngine
    tunnelRegistry: TunnelRegistry
    tunnelRelay: TunnelRelay
    socketIo: import('socket.io').Server
    corsOrigins?: string[]
    relayMode?: boolean
    officialWebUrl?: string
    lobstearService?: LobstearService | null
}): Promise<BunServer<WebSocketData | TunnelWsData | PoolWsData>> {
    const isCompiled = isBunCompiled()
    const embeddedAssetMap = isCompiled ? await loadEmbeddedAssetMap() : null
    const app = createWebApp({
        getSyncEngine: options.getSyncEngine,
        getSseManager: options.getSseManager,
        getVisibilityTracker: options.getVisibilityTracker,
        store: options.store,
        authService: options.authService,
        revocationCache: options.revocationCache,
        vapidPublicKey: options.vapidPublicKey,
        corsOrigins: options.corsOrigins,
        embeddedAssetMap,
        relayMode: options.relayMode,
        officialWebUrl: options.officialWebUrl,
        lobstearService: options.lobstearService
    })

    const socketHandler = options.socketEngine.handler()
    const cliNamespace = options.socketIo.of('/cli')
    const tunnelRelay = options.tunnelRelay

    const server = Bun.serve<WebSocketData | TunnelWsData | PoolWsData>({
        hostname: configuration.listenHost,
        port: configuration.listenPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        maxRequestBodySize: Math.max(68 * 1024 * 1024, socketHandler.maxRequestBodySize),
        websocket: {
            open(ws) {
                if ('_pool' in ws.data) {
                    tunnelRelay.addPoolWs(ws as ServerWebSocket<PoolWsData>)
                } else if ('_tunnel' in ws.data) {
                    tunnelRelay.onOpen(ws as ServerWebSocket<TunnelWsData>)
                } else {
                    socketHandler.websocket.open(ws as ServerWebSocket<WebSocketData>)
                }
            },
            message(ws, message) {
                if ('_pool' in ws.data) {
                    tunnelRelay.onPoolMessage(ws as ServerWebSocket<PoolWsData>, message)
                } else if ('_tunnel' in ws.data) {
                    tunnelRelay.onMessage(ws as ServerWebSocket<TunnelWsData>, message)
                } else {
                    socketHandler.websocket.message(ws as ServerWebSocket<WebSocketData>, message)
                }
            },
            close(ws, code, message) {
                if ('_pool' in ws.data) {
                    tunnelRelay.removePoolWs(ws as ServerWebSocket<PoolWsData>)
                } else if ('_tunnel' in ws.data) {
                    tunnelRelay.onClose(ws as ServerWebSocket<TunnelWsData>)
                } else {
                    socketHandler.websocket.close(ws as ServerWebSocket<WebSocketData>, code, message)
                }
            },
            drain(ws) {
                if ('_tunnel' in ws.data) {
                    tunnelRelay.onDrain(ws as ServerWebSocket<TunnelWsData>)
                }
            },
            maxPayloadLength: socketHandler.websocket.maxPayloadLength,
        },
        fetch: (req, server) => {
            const url = new URL(req.url)

            // Pool WebSocket: /tunnel/pool?token=xxx&machineId=yyy
            if (url.pathname === '/tunnel/pool') {
                const token = url.searchParams.get('token')
                const machineId = url.searchParams.get('machineId')

                if (!token || !machineId) {
                    return new Response('Bad request', { status: 400 })
                }

                const authResult = options.authService.authenticateCliToken(token)
                if (!authResult) {
                    return new Response('Unauthorized', { status: 401 })
                }

                const upgraded = server.upgrade(req, {
                    data: { _tunnel: true, _pool: true, machineId, tunnelId: null } as PoolWsData
                })
                if (!upgraded) {
                    return new Response('WebSocket upgrade failed', { status: 500 })
                }
                return undefined as unknown as Response
            }

            // Tunnel WebSocket upgrade: /tunnel/ws/:tunnelId?token=xxx&role=connect|runner
            if (url.pathname.startsWith('/tunnel/ws/')) {
                const tunnelId = url.pathname.slice('/tunnel/ws/'.length)
                const token = url.searchParams.get('token')
                const role = url.searchParams.get('role')

                if (!tunnelId || !token || (role !== 'connect' && role !== 'runner')) {
                    return new Response('Bad request', { status: 400 })
                }

                const authResult = options.authService.authenticateCliToken(token)
                if (!authResult) {
                    return new Response('Unauthorized', { status: 401 })
                }

                const entry = options.tunnelRegistry.get(tunnelId)
                if (!entry) {
                    return new Response('Tunnel not found', { status: 404 })
                }

                const upgraded = server.upgrade(req, {
                    data: { _tunnel: true as const, tunnelId, role } as TunnelWsData
                })
                if (!upgraded) {
                    return new Response('WebSocket upgrade failed', { status: 500 })
                }
                return undefined as unknown as Response
            }

            // Tunnel protocol query: /tunnel/protocol/:tunnelId?token=xxx
            if (url.pathname.startsWith('/tunnel/protocol/')) {
                const tunnelId = url.pathname.slice('/tunnel/protocol/'.length)
                const token = url.searchParams.get('token')
                if (!token) return new Response('Unauthorized', { status: 401 })
                const authResult = options.authService.authenticateCliToken(token)
                if (!authResult) return new Response('Unauthorized', { status: 401 })
                const entry = options.tunnelRegistry.get(tunnelId)
                if (!entry) return new Response('Tunnel not found', { status: 404 })
                const connectSocket = cliNamespace.sockets.get(entry.connectSocketId)
                const runnerSocket = cliNamespace.sockets.get(entry.runnerSocketId)
                const hasWsCap = (s: typeof connectSocket) => {
                    const caps = (s?.handshake?.auth as any)?.capabilities
                    return caps?.wsTunnel === true
                }
                return Response.json({
                    connect: hasWsCap(connectSocket) ? 'websocket' : 'socketio',
                    runner: hasWsCap(runnerSocket) ? 'websocket' : 'socketio',
                })
            }

            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, server as unknown as Parameters<typeof socketHandler.fetch>[1])
            }
            return app.fetch(req)
        }
    })

    console.log(`[Web] hub listening on ${configuration.listenHost}:${configuration.listenPort}`)
    console.log(`[Web] public URL: ${configuration.publicUrl}`)

    return server
}
