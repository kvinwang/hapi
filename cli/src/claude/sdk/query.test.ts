import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Query } from './query'

/**
 * Regression: a control request (initialize / get_context_usage / get_usage)
 * used to await a response forever once the Claude child process was gone,
 * which stranded the whole remote loop after `/clear` aborted the query.
 */
describe('Query control requests', () => {
    it('rejects in-flight control requests when the child stream closes', async () => {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, Promise.resolve())

        const pending = query.getContextUsage()
        // Child dies: stdout closes, no control response will ever arrive.
        stdout.end()

        await expect(pending).rejects.toThrow()
    })

    it('rejects in-flight control requests when the process is aborted', async () => {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, Promise.resolve())

        const pending = query.getUsage()
        query.setError(new Error('Claude Code process aborted by user'))

        await expect(pending).rejects.toThrow('aborted by user')
    })

    it('rejects new control requests issued after the stream failed', async () => {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, Promise.resolve())

        query.setError(new Error('Claude Code process aborted by user'))

        await expect(query.initialize()).rejects.toThrow('aborted by user')
    })

    it('still resolves control requests that get a response', async () => {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const query = new Query(stdin, stdout, Promise.resolve())

        const written = new Promise<string>((resolve) => {
            stdin.once('data', (chunk) => resolve(chunk.toString()))
        })
        const pending = query.initialize()
        const requestId = JSON.parse(await written).request_id
        stdout.write(JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: requestId }
        }) + '\n')

        await expect(pending).resolves.toMatchObject({ subtype: 'success' })
    })
})
