import chalk from 'chalk'
import { ApiClient } from '@/api/api'
import type { SessionHistoryMessage, SessionHistoryRole } from '@/api/types'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

type SessionSubcommand = 'history'
type OutputFormat = 'json' | 'text'

type HistoryCommandArgs = {
    sessionId: string
    tail?: number
    search?: string
    role?: SessionHistoryRole
    afterSeq?: number
    beforeSeq?: number
    limit?: number
    format: OutputFormat
    snippet: boolean
}

function parsePositiveInt(raw: string, name: string, max: number = 200): number {
    const value = Number(raw)
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > max) {
        throw new Error(`${name} must be an integer between 1 and ${max}`)
    }
    return value
}

function parseNonNegativeInt(raw: string, name: string): number {
    const value = Number(raw)
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`)
    }
    return value
}

function parseHistoryArgs(args: string[]): HistoryCommandArgs {
    let sessionId = ''
    let tail: number | undefined
    let search: string | undefined
    let role: SessionHistoryRole | undefined
    let afterSeq: number | undefined
    let beforeSeq: number | undefined
    let limit: number | undefined
    let format: OutputFormat = 'text'
    let snippet = false

    const readValue = (arg: string, index: number): { value: string; nextIndex: number } => {
        const eqIndex = arg.indexOf('=')
        if (eqIndex >= 0) {
            return { value: arg.slice(eqIndex + 1), nextIndex: index }
        }
        const next = args[index + 1]
        if (!next) {
            throw new Error(`Missing value for ${arg}`)
        }
        return { value: next, nextIndex: index + 1 }
    }

    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]
        if (arg === '--snippet') {
            snippet = true
            continue
        }

        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const { value, nextIndex } = readValue(arg, i)
            sessionId = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--tail' || arg.startsWith('--tail=')) {
            const { value, nextIndex } = readValue(arg, i)
            tail = parsePositiveInt(value, '--tail')
            i = nextIndex
            continue
        }
        if (arg === '--search' || arg.startsWith('--search=')) {
            const { value, nextIndex } = readValue(arg, i)
            search = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--role' || arg.startsWith('--role=')) {
            const { value, nextIndex } = readValue(arg, i)
            if (value !== 'user' && value !== 'assistant' && value !== 'tool') {
                throw new Error('--role must be one of: user, assistant, tool')
            }
            role = value
            i = nextIndex
            continue
        }
        if (arg === '--after-seq' || arg.startsWith('--after-seq=')) {
            const { value, nextIndex } = readValue(arg, i)
            afterSeq = parseNonNegativeInt(value, '--after-seq')
            i = nextIndex
            continue
        }
        if (arg === '--before-seq' || arg.startsWith('--before-seq=')) {
            const { value, nextIndex } = readValue(arg, i)
            beforeSeq = parsePositiveInt(value, '--before-seq', Number.MAX_SAFE_INTEGER)
            i = nextIndex
            continue
        }
        if (arg === '--limit' || arg.startsWith('--limit=')) {
            const { value, nextIndex } = readValue(arg, i)
            limit = parsePositiveInt(value, '--limit')
            i = nextIndex
            continue
        }
        if (arg === '--format' || arg.startsWith('--format=')) {
            const { value, nextIndex } = readValue(arg, i)
            if (value !== 'json' && value !== 'text') {
                throw new Error('--format must be json or text')
            }
            format = value
            i = nextIndex
            continue
        }

        throw new Error(`Unknown option: ${arg}`)
    }

    if (!sessionId) {
        throw new Error('Missing required option --session <id>')
    }
    if (search !== undefined && search.length === 0) {
        throw new Error('--search cannot be empty')
    }
    if (afterSeq !== undefined && beforeSeq !== undefined && afterSeq >= beforeSeq) {
        throw new Error('--after-seq must be less than --before-seq')
    }

    return {
        sessionId,
        tail,
        search,
        role,
        afterSeq,
        beforeSeq,
        limit,
        format,
        snippet
    }
}

function compactJson(value: unknown): string {
    try {
        const json = JSON.stringify(value)
        return typeof json === 'string' ? json : ''
    } catch {
        return '[unserializable-content]'
    }
}

function trimForDisplay(text: string, maxLength: number = 300): string {
    if (text.length <= maxLength) {
        return text
    }
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function printHistoryText(messages: SessionHistoryMessage[]): void {
    if (messages.length === 0) {
        console.log(chalk.gray('No messages found.'))
        return
    }

    for (const message of messages) {
        const seq = message.seq ?? '-'
        const createdAt = new Date(message.createdAt).toISOString()
        const role = message.role ?? 'unknown'
        const text = message.text ?? compactJson(message.content)
        console.log(chalk.bold(`[${seq}] ${createdAt} ${role}`))
        console.log(trimForDisplay(text))
        if (message.snippet) {
            console.log(chalk.gray(`snippet: ${message.snippet}`))
        }
        console.log('')
    }
}

function printUsage(): void {
    console.log('Usage: hapi session history --session <id> [options]')
    console.log('')
    console.log('Options:')
    console.log('  --tail <n>           Latest N messages')
    console.log('  --search <keyword>   Keyword search')
    console.log('  --role <role>        user | assistant | tool')
    console.log('  --after-seq <n>      Messages after sequence')
    console.log('  --before-seq <n>     Messages before sequence')
    console.log('  --limit <n>          Max messages (1-200)')
    console.log('  --format <fmt>       json | text (default: text)')
    console.log('  --snippet            Include snippets for search')
}

async function runHistory(args: string[]): Promise<void> {
    const parsed = parseHistoryArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    const result = await api.getSessionHistory(parsed.sessionId, {
        tail: parsed.tail,
        search: parsed.search,
        role: parsed.role,
        afterSeq: parsed.afterSeq,
        beforeSeq: parsed.beforeSeq,
        limit: parsed.limit,
        snippet: parsed.snippet
    })

    if (parsed.format === 'json') {
        console.log(JSON.stringify(result, null, 2))
        return
    }

    printHistoryText(result.messages)
}

export const sessionCommand: CommandDefinition = {
    name: 'session',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        const subcommand = commandArgs[0] as SessionSubcommand | undefined
        try {
            if (subcommand === 'history') {
                await runHistory(commandArgs)
                return
            }

            printUsage()
            process.exitCode = 1
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            printUsage()
            process.exit(1)
        }
    }
}
