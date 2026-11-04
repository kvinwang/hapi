import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAxiosError } from 'axios'
import { ApiClient } from '@/api/api'
import { initializeToken } from '@/ui/tokenInit'
import type { ThreadInbox } from '@hapi/protocol/threads'
import type { CommandDefinition } from './types'

async function output(value: unknown, format: string): Promise<void> {
    const text = format === 'json' ? JSON.stringify(value) : JSON.stringify(value, null, 2)
    await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${text}\n`, error => (error ? reject(error) : resolve()))
    })
}

export const threadCommand: CommandDefinition = {
    name: 'thread',
    requiresRuntimeAssets: false,
    async run({ commandArgs }) {
        if (!commandArgs.length || commandArgs.includes('--help')) {
            console.log(
                'Usage: hapi thread <create|list|info|members|add|join|leave|send|inbox|history|watch|settings|archive|restore> [thread]\nOptions: --description, --session, --text, --body-file, --mention (repeatable), --reply-to, --client-message-id, --thread, --wait <0-60>, --mentions, --peek, --limit <1-100>, --after, --before, --mention-wake on|off, --format json|text\nHAPI_SESSION_ID is required. inbox consumes messages after successful output; --peek and history do not. watch continuously consumes messages; use inbox --peek to inspect and --wait for one bounded wait.'
            )
            return
        }
        try {
            const sessionId = process.env.HAPI_SESSION_ID
            if (!sessionId)
                throw new Error('HAPI_SESSION_ID is required; preserve it when using sudo or switching users.')
            const { positionals, values } = parseArgs({
                args: commandArgs,
                allowPositionals: true,
                options: {
                    description: { type: 'string' },
                    session: { type: 'string' },
                    text: { type: 'string' },
                    'body-file': { type: 'string' },
                    mention: { type: 'string', multiple: true },
                    'reply-to': { type: 'string' },
                    'client-message-id': { type: 'string' },
                    thread: { type: 'string' },
                    wait: { type: 'string' },
                    mentions: { type: 'boolean' },
                    peek: { type: 'boolean' },
                    limit: { type: 'string' },
                    after: { type: 'string' },
                    before: { type: 'string' },
                    'mention-wake': { type: 'string' },
                    format: { type: 'string', default: 'json' }
                }
            })
            const [command, thread] = positionals
            if (values.format !== 'json' && values.format !== 'text') throw new Error('--format must be json or text')
            await initializeToken()
            const api = await ApiClient.create()
            const request = <T = unknown>(
                method: 'GET' | 'POST',
                path: string,
                body?: unknown,
                query?: Record<string, string | number | boolean | undefined>
            ) => api.threadRequest<T>(method, path, sessionId, body, query)
            if (command === 'inbox' || command === 'watch') {
                if (command === 'watch' && values.peek)
                    throw new Error(
                        'Use inbox --peek for non-consuming reads; watch requires consumption to avoid repeating messages.'
                    )
                if (command === 'watch' && values.wait !== undefined && Number(values.wait) < 1)
                    throw new Error('watch --wait must be between 1 and 60 seconds')
                do {
                    const result = await request<ThreadInbox>('GET', '/inbox', undefined, {
                        threadId: values.thread,
                        mentions: values.mentions,
                        wait: values.wait ?? (command === 'watch' ? 30 : 0),
                        limit: values.limit
                    })
                    await output(result, values.format)
                    if (!values.peek && result.messages.length)
                        await request('POST', '/consume', {
                            ids: result.messages.map(m => m.id)
                        })
                } while (command === 'watch')
                return
            }
            if (command === 'list') {
                await output(await request('GET', ''), values.format)
                return
            }
            if (!thread) throw new Error('Thread ID (or a name for create) is required')
            const path = `/${encodeURIComponent(thread)}`
            let result: unknown
            switch (command) {
                case 'create':
                    result = await request('POST', '', {
                        name: thread,
                        description: values.description ?? ''
                    })
                    break
                case 'info':
                    result = await request('GET', path)
                    break
                case 'members':
                    result = (await request<{ members: unknown[] }>('GET', path)).members
                    break
                case 'add':
                    if (!values.session) throw new Error('--session is required')
                    result = await request('POST', `${path}/add`, {
                        sessionId: values.session
                    })
                    break
                case 'join':
                case 'leave':
                case 'archive':
                case 'restore':
                    result = await request('POST', `${path}/${command}`, {})
                    break
                case 'settings':
                    if (!['on', 'off'].includes(values['mention-wake'] ?? ''))
                        throw new Error('--mention-wake must be on or off')
                    result = await request('POST', `${path}/settings`, {
                        mentionWake: values['mention-wake'] === 'on'
                    })
                    break
                case 'history':
                    result = await request('GET', `${path}/history`, undefined, {
                        after: values.after,
                        before: values.before,
                        limit: values.limit
                    })
                    break
                case 'send': {
                    if (values.text && values['body-file']) throw new Error('Use either --text or --body-file')
                    const text = values['body-file'] ? await readFile(values['body-file'], 'utf8') : values.text ?? ''
                    if (!text.trim() && !values.mention?.length) throw new Error('--text, --body-file, or --mention is required')
                    result = await request('POST', `${path}/send`, {
                        text,
                        mentions: values.mention ?? [],
                        replyTo: values['reply-to'],
                        clientMessageId: values['client-message-id'] ?? randomUUID()
                    })
                    break
                }
                default:
                    throw new Error(`Unknown thread command: ${command}`)
            }
            await output(result, values.format)
        } catch (error) {
            const message = isAxiosError(error)
                ? (error.response?.data?.error ?? error.message)
                : error instanceof Error
                  ? error.message
                  : String(error)
            console.error(message)
            process.exitCode = 1
        }
    }
}
