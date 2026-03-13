import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { logger } from 'hono/logger'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
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
import { createSyncRoutes } from './routes/sync'
import { createUsageRoutes } from './routes/usage'
import { createVoiceRoutes } from './routes/voice'
import { createApiKeyRoutes } from './routes/apiKeys'
import { createFileRoutes } from './routes/files'
import { createPreferencesRoutes } from './routes/preferences'
import { createLobstearRoutes, type LobstearService } from '../lobstear'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { Server as BunServer } from 'bun'
import type { Server as SocketEngine } from '@socket.io/bun-engine'
import type { WebSocketData } from '@socket.io/bun-engine'
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'
import type { Store } from '../store'
import type { AuthService } from '../auth/authService'
import type { RevocationCache } from '../auth/revocationCache'

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

function serveEmbeddedAsset(asset: EmbeddedWebAsset): Response {
    return new Response(Bun.file(asset.sourcePath), {
        headers: {
            'Content-Type': asset.mimeType
        }
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
            allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowHeaders: ['authorization', 'content-type'],
            credentials: true,
        })
        app.use('/api/*', corsMiddleware)
        app.use('/cli/*', corsMiddleware)
    }

    // Serve install script (public, no auth)
    app.get('/install', (c) => {
        return c.redirect('https://raw.githubusercontent.com/kvinwang/hapi/main/install.sh', 302)
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

    app.use('/assets/*', serveStatic({ root: distDir }))

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({ root: distDir })(c, next)
    })

    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({ root: distDir, path: 'index.html' })(c, next)
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
    corsOrigins?: string[]
    relayMode?: boolean
    officialWebUrl?: string
    lobstearService?: LobstearService | null
}): Promise<BunServer<WebSocketData>> {
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

    const server = Bun.serve({
        hostname: configuration.listenHost,
        port: configuration.listenPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        maxRequestBodySize: Math.max(50 * 1024 * 1024, socketHandler.maxRequestBodySize),
        websocket: socketHandler.websocket,
        fetch: (req, server) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, server)
            }
            return app.fetch(req)
        }
    })

    console.log(`[Web] hub listening on ${configuration.listenHost}:${configuration.listenPort}`)
    console.log(`[Web] public URL: ${configuration.publicUrl}`)

    return server
}
