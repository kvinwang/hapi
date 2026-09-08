import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from './codexAppServerClient'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('@/utils/process', () => ({ killProcessByChildProcess: mocks.kill }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }))

type Request = { id: number; method: string; params?: Record<string, unknown> }

function mockServer(respond: (request: Request) => unknown) {
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
    })
    const requests: Request[] = []
    child.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as Request
        requests.push(request)
        const result = respond(request)
        if (result !== undefined) {
            queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'))
        }
    })
    mocks.spawn.mockReturnValue(child)
    mocks.kill.mockImplementation(async () => { child.emit('exit', 0, null) })
    return { child, requests }
}

describe('CodexAppServerClient model discovery', () => {
    let client: CodexAppServerClient | undefined
    afterEach(async () => {
        await client?.disconnect()
        vi.clearAllMocks()
    })

    it('initializes and fetches every page, using model rather than catalog id', async () => {
        const { requests } = mockServer((request) => {
            if (request.method === 'initialize') return {}
            if (request.method !== 'model/list') return undefined
            return request.params?.cursor ? {
                data: [{ id: 'catalog-b', model: 'model-b', displayName: 'Model B' }], nextCursor: null
            } : {
                data: [
                    { id: 'catalog-a', model: 'model-a', displayName: 'Model A', description: 'Available', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'More reasoning' }], defaultReasoningEffort: 'ultra', isDefault: true },
                    { model: 'hidden', displayName: 'Hidden', hidden: true }
                ], nextCursor: 'page-2'
            }
        })
        client = new CodexAppServerClient()
        await client.connect()
        await client.initialize({ clientInfo: { name: 'test', version: '1' } })
        expect(await client.listModels()).toEqual([
            { value: 'model-a', displayName: 'Model A', description: 'Available', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'More reasoning' }], defaultReasoningEffort: 'ultra', isDefault: true },
            { value: 'model-b', displayName: 'Model B' }
        ])
        expect(requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list'])
        expect(requests[2].params).toEqual({ limit: 100, includeHidden: false })
        expect(requests[3].params?.cursor).toBe('page-2')
    })

    it('rejects malformed catalogs', async () => {
        mockServer(() => ({ data: [{ model: '' }], nextCursor: null }))
        client = new CodexAppServerClient()
        await expect(client.listModels()).rejects.toThrow()
    })

    it('deduplicates models across pages', async () => {
        mockServer((request) => ({
            data: [{ model: 'same-model', displayName: 'Same Model' }],
            nextCursor: request.params?.cursor ? null : 'next'
        }))
        client = new CodexAppServerClient()
        expect(await client.listModels()).toHaveLength(1)
    })

    it('rejects repeated pagination cursors instead of looping forever', async () => {
        mockServer(() => ({ data: [], nextCursor: 'same-cursor' }))
        client = new CodexAppServerClient()
        await expect(client.listModels()).rejects.toThrow('repeated a pagination cursor')
    })

    it('aborts an unresponsive discovery request', async () => {
        mockServer(() => undefined)
        client = new CodexAppServerClient()
        await expect(client.listModels({ signal: AbortSignal.timeout(10) })).rejects.toThrow('Request aborted')
    })

    it('rejects when codex is not installed', async () => {
        const { child } = mockServer(() => undefined)
        client = new CodexAppServerClient()
        const pending = client.listModels()
        queueMicrotask(() => child.emit('error', new Error('ENOENT')))
        await expect(pending).rejects.toThrow('Failed to spawn codex app-server')
    })
})
