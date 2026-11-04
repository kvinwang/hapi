import { expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Server } from 'socket.io'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Store, type Permission } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { SyncEngine } from '../../sync/syncEngine'
import { createGroupRoutes } from './groups'

it('runs real CLI create/add/send/peek/inbox against an isolated group API', async () => {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, new Server(), new RpcRegistry(), new SSEManager(0, new VisibilityTracker()))
    const a = engine.createSession('cli-a', { path: '/tmp', host: 'test' }, 'default').id
    const b = engine.createSession('cli-b', { path: '/tmp', host: 'test' }, 'default').id
    const app = new Hono<{ Variables: { namespace: string; permissions: Permission[] } }>()
    app.use('*', async (c, next) => { c.set('namespace', 'default'); c.set('permissions', ['admin']); await next() })
    app.route('/cli', createGroupRoutes(() => engine, true))
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
    const home = await mkdtemp(join(tmpdir(), 'hapi-group-test-'))
    const cli = resolve(import.meta.dir, '../../../../cli')
    async function run(sessionId: string, args: string[]): Promise<unknown> {
        const child = Bun.spawn([process.execPath, '--cwd', cli, 'src/index.ts', 'group', ...args], {
            env: { PATH: process.env.PATH, HAPI_HOME: home, HAPI_SESSION_ID: sessionId, HAPI_API_URL: `http://127.0.0.1:${server.port}`, CLI_API_TOKEN: 'isolated-test' },
            stdout: 'pipe', stderr: 'pipe'
        })
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect(stderr).toBe('')
        expect(exit).toBe(0)
        return JSON.parse(stdout)
    }
    try {
        const created = await run(a, ['create', 'CLI smoke']) as { group: { id: string } }
        const id = created.group.id
        await run(a, ['add', id, '--session', b])
        const sent = await run(a, ['send', id, '--mention', b, '--text', 'Review commit abc123.']) as { mentions: Array<{ reason: string }> }
        expect(sent.mentions[0].reason).toBe('inactive')
        await run(b, ['inbox', '--peek'])
        expect(store.groups.unread(id, b)).toBe(1)
        await run(b, ['inbox', '--mentions'])
        expect(store.groups.unread(id, b)).toBe(0)
        await run(b, ['inbox', '--wait', '1'])
        const history = await run(b, ['history', id]) as { messages: Array<{ text: string }> }
        expect(history.messages[0].text).toBe('Review commit abc123.')
    } finally {
        server.stop(true)
        engine.stop()
        await rm(home, { recursive: true, force: true })
    }
}, 15_000)
