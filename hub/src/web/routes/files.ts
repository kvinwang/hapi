import { Hono } from 'hono'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Store } from '../../store'
import type { AuthService } from '../../auth/authService'
import { hasPermission } from '../../auth/permissions'

type FileEnv = {
    Variables: Record<string, never>
}

const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/** Validate file ID format: UUID with extension (1-10 chars) */
const FILE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.\w{1,10}$/

const EXT_TO_MIME: Record<string, string> = {
    // images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    avif: 'image/avif',
    // documents
    pdf: 'application/pdf',
    html: 'text/html',
    htm: 'text/html',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    // archives
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    // media
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',
}

export function createFileRoutes(filesDir: string, store: Store, authService: AuthService): Hono<FileEnv> {
    const app = new Hono<FileEnv>()

    app.get('/files/:sessionId/:fileId', async (c) => {
        const sessionId = c.req.param('sessionId')
        const fileId = c.req.param('fileId')

        if (!SESSION_ID_PATTERN.test(sessionId) || !FILE_ID_PATTERN.test(fileId)) {
            return c.json({ error: 'Not found' }, 404)
        }

        const session = store.sessions.getSession(sessionId)
        if (!session) {
            return c.json({ error: 'Not found' }, 404)
        }

        // Access check: shared session (public) OR authenticated user with sessions:read
        let allowed = !!session.shareToken
        if (!allowed) {
            const authorization = c.req.header('authorization')
            const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : c.req.query('token') ?? undefined
            if (token) {
                const auth = await authService.verifyJwt(token)
                if (auth && hasPermission(auth.permissions, 'sessions:read') && auth.namespace === session.namespace) {
                    allowed = true
                }
            }
        }

        if (!allowed) {
            return c.json({ error: 'Not found' }, 404)
        }

        const filePath = join(filesDir, sessionId, fileId)
        if (!existsSync(filePath)) {
            return c.json({ error: 'Not found' }, 404)
        }

        const ext = fileId.split('.').pop() ?? ''
        const mimeType = EXT_TO_MIME[ext] ?? 'application/octet-stream'

        return new Response(Bun.file(filePath), {
            headers: {
                'Content-Type': mimeType,
                'Cache-Control': 'public, max-age=31536000, immutable'
            }
        })
    })

    return app
}
