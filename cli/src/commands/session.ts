import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import chalk from 'chalk'
import { ApiClient } from '@/api/api'
import type { Metadata, Session, SessionHistoryMessage, SessionHistoryRole } from '@/api/types'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'
import { countContextTurns, formatSessionContext, parseSessionContextArgs } from './sessionContext'
import { formatToolInspections, inspectToolCalls, parseSessionInspectArgs, rawInspectionMessages } from './sessionInspect'

type SessionSubcommand = 'history' | 'context' | 'inspect' | 'create' | 'set-title' | 'set-summary' | 'export'
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
    full: boolean
}

type CreateCommandArgs = {
    parentSessionId: string
    path?: string
    name?: string
    tag?: string
    format: OutputFormat
}

type SetTitleCommandArgs = {
    sessionId: string
    title: string
    format: OutputFormat
}

type ExportCommandArgs = {
    sessionId: string
    /** When set, write JSON to this path instead of stdout. */
    outputPath?: string
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

function readOptionValue(args: string[], arg: string, index: number): { value: string; nextIndex: number } {
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
    let full = false

    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]
        if (arg === '--snippet') {
            snippet = true
            continue
        }
        if (arg === '--full') {
            full = true
            continue
        }

        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            sessionId = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--tail' || arg.startsWith('--tail=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            tail = parsePositiveInt(value, '--tail')
            i = nextIndex
            continue
        }
        if (arg === '--search' || arg.startsWith('--search=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            search = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--role' || arg.startsWith('--role=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            if (value !== 'user' && value !== 'assistant' && value !== 'tool') {
                throw new Error('--role must be one of: user, assistant, tool')
            }
            role = value
            i = nextIndex
            continue
        }
        if (arg === '--after-seq' || arg.startsWith('--after-seq=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            afterSeq = parseNonNegativeInt(value, '--after-seq')
            i = nextIndex
            continue
        }
        if (arg === '--before-seq' || arg.startsWith('--before-seq=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            beforeSeq = parsePositiveInt(value, '--before-seq', Number.MAX_SAFE_INTEGER)
            i = nextIndex
            continue
        }
        if (arg === '--limit' || arg.startsWith('--limit=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            limit = parsePositiveInt(value, '--limit')
            i = nextIndex
            continue
        }
        if (arg === '--format' || arg.startsWith('--format=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
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
        snippet,
        full
    }
}

function parseCreateArgs(args: string[]): CreateCommandArgs {
    let parentSessionId: string | undefined
    let path: string | undefined
    let name: string | undefined
    let tag: string | undefined
    let format: OutputFormat = 'text'

    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]

        if (arg === '--parent' || arg.startsWith('--parent=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            parentSessionId = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--path' || arg.startsWith('--path=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            path = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--name' || arg.startsWith('--name=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            name = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--tag' || arg.startsWith('--tag=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            tag = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--format' || arg.startsWith('--format=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            if (value !== 'json' && value !== 'text') {
                throw new Error('--format must be json or text')
            }
            format = value
            i = nextIndex
            continue
        }

        throw new Error(`Unknown option: ${arg}`)
    }

    if (path !== undefined && path.length === 0) {
        throw new Error('--path cannot be empty')
    }
    if (name !== undefined && name.length === 0) {
        throw new Error('--name cannot be empty')
    }
    if (tag !== undefined && tag.length === 0) {
        throw new Error('--tag cannot be empty')
    }
    if (!parentSessionId) {
        throw new Error('Missing required option --parent <id>')
    }

    return {
        parentSessionId,
        path,
        name,
        tag,
        format
    }
}

function parseSetTitleArgs(args: string[]): SetTitleCommandArgs {
    let sessionId = process.env.HAPI_SESSION_ID?.trim() || ''
    let format: OutputFormat = 'text'
    const titleParts: string[] = []

    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]

        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            sessionId = value.trim()
            i = nextIndex
            continue
        }
        if (arg === '--format' || arg.startsWith('--format=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            if (value !== 'json' && value !== 'text') {
                throw new Error('--format must be json or text')
            }
            format = value
            i = nextIndex
            continue
        }

        titleParts.push(arg)
    }

    const title = titleParts.join(' ').trim()
    if (!sessionId) {
        throw new Error('Missing session ID. Set HAPI_SESSION_ID or pass --session <id>')
    }
    if (!title) {
        throw new Error('Missing title')
    }

    return {
        sessionId,
        title,
        format
    }
}

function parseSetSummaryArgs(args: string[]): SetTitleCommandArgs {
    const parsed = parseSetTitleArgs(args)
    return { ...parsed, title: parsed.title }
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

function printHistoryText(messages: SessionHistoryMessage[], full: boolean): void {
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
        console.log(full ? text : trimForDisplay(text))
        if (message.snippet) {
            console.log(chalk.gray(`snippet: ${message.snippet}`))
        }
        console.log('')
    }
}

function deriveChildMetadata(parent: Session, args: CreateCommandArgs): Metadata {
    const parentMetadata = parent.metadata
    if (!parentMetadata) {
        throw new Error('Parent session metadata is missing')
    }

    const metadata: Metadata = {
        ...parentMetadata,
        path: args.path ?? parentMetadata.path,
        name: args.name ?? parentMetadata.name,
        claudeSessionId: undefined,
        codexSessionId: undefined,
        geminiSessionId: undefined,
        opencodeSessionId: undefined,
        cursorSessionId: undefined,
        grokSessionId: undefined,
        hostPid: undefined,
        lifecycleState: undefined,
        lifecycleStateSince: undefined,
        archivedBy: undefined,
        archiveReason: undefined,
        startedFromRunner: undefined,
        startedBy: undefined
    }

    if (args.path && args.path !== parentMetadata.path) {
        metadata.worktree = undefined
        metadata.summary = undefined
    }

    return metadata
}

function parseExportArgs(args: string[]): ExportCommandArgs {
    let sessionId = process.env.HAPI_SESSION_ID?.trim() || ''
    let outputPath: string | undefined
    let sawExplicitSession = false

    for (let i = 1; i < args.length; i += 1) {
        const arg = args[i]

        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            sessionId = value.trim()
            sawExplicitSession = true
            i = nextIndex
            continue
        }
        if (arg === '--output' || arg === '-o' || arg.startsWith('--output=')) {
            const { value, nextIndex } = readOptionValue(args, arg, i)
            outputPath = value.trim()
            i = nextIndex
            continue
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown option: ${arg}`)
        }

        // Positional session id: `hapi session export <id>`
        if (!arg.trim()) {
            throw new Error('Session id cannot be empty')
        }
        if (sawExplicitSession) {
            throw new Error(`Unexpected argument: ${arg}`)
        }
        sessionId = arg.trim()
        sawExplicitSession = true
    }

    if (!sessionId) {
        throw new Error('Missing session ID. Pass --session <id>, a positional id, or set HAPI_SESSION_ID')
    }
    if (outputPath !== undefined && outputPath.length === 0) {
        throw new Error('--output cannot be empty')
    }

    return { sessionId, outputPath }
}

function printUsage(): void {
    console.log('Usage:')
    console.log('  hapi session history --session <id> [options]')
    console.log('  hapi session context [--session <id>] [options]')
    console.log('  hapi session inspect <seq> [--session <id>] [options]')
    console.log('  hapi session create [options]')
    console.log('  hapi session set-title [--session <id>] <title>')
    console.log('  hapi session set-summary [--session <id>] <summary>')
    console.log('  hapi session export [--session <id>] [-o <file>]')
    console.log('')
    console.log('History options:')
    console.log('  --tail <n>           Latest N messages')
    console.log('  --search <keyword>   Keyword search')
    console.log('  --role <role>        user | assistant | tool')
    console.log('  --after-seq <n>      Messages after sequence')
    console.log('  --before-seq <n>     Messages before sequence')
    console.log('  --limit <n>          Max messages (1-200)')
    console.log('  --format <fmt>       json | text (default: text)')
    console.log('  --snippet            Include snippets for search')
    console.log('  --full               Show full message text without truncation')
    console.log('')
    console.log('Context options:')
    console.log('  --session <id>       Session ID (defaults to HAPI_SESSION_ID)')
    console.log('  --turns <n>          Latest user turns (default: 1, max: 100)')
    console.log('  --max-chars <n>      Output character budget (default: 16000)')
    console.log('  --tools <mode>       none | summary | full (default: summary)')
    console.log('  --tail <n>           Latest N raw messages before semantic filtering')
    console.log('  --search <keyword>   Keyword search')
    console.log('  --role <role>        user | assistant | tool')
    console.log('  --after-seq <n>      Messages after sequence')
    console.log('  --before-seq <n>     Messages before sequence')
    console.log('  --limit <n>          Max matched messages (1-200)')
    console.log('  --snippet            Request search snippets')
    console.log('  --full               Keep full tool input/results')
    console.log('')
    console.log('Inspect options:')
    console.log('  --session <id>       Session ID (defaults to HAPI_SESSION_ID)')
    console.log('  --format <fmt>       text | json (default: text)')
    console.log('  --raw                Output the original call/result messages as JSON')
    console.log('')
    console.log('Create options:')
    console.log('  --parent <id>        Parent session ID (required)')
    console.log('  --path <dir>         Override inherited path')
    console.log('  --name <name>        Override inherited name')
    console.log('  --tag <tag>          Explicit session tag')
    console.log('  --format <fmt>       json | text (default: text)')
    console.log('')
    console.log('Set-title options:')
    console.log('  --session <id>       Session ID (defaults to HAPI_SESSION_ID)')
    console.log('  --format <fmt>       json | text (default: text)')
    console.log('')
    console.log('Export options:')
    console.log('  --session <id>       Session ID (defaults to HAPI_SESSION_ID)')
    console.log('  -o, --output <file>  Write JSON to file (default: stdout)')
    console.log('  Full conversation JSON matches public shared ?fmt=json')
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

    printHistoryText(result.messages, parsed.full)
}

async function runContext(args: string[]): Promise<void> {
    const parsed = parseSessionContextArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    const messages: SessionHistoryMessage[] = []
    let beforeSeq: number | undefined

    const hasHistoryQuery = parsed.tail !== undefined
        || parsed.search !== undefined
        || parsed.role !== undefined
        || parsed.afterSeq !== undefined
        || parsed.beforeSeq !== undefined
        || parsed.limit !== undefined
        || parsed.snippet

    if (hasHistoryQuery) {
        const result = await api.getSessionHistory(parsed.sessionId, {
            tail: parsed.tail,
            search: parsed.search,
            role: parsed.role,
            afterSeq: parsed.afterSeq,
            beforeSeq: parsed.beforeSeq,
            limit: parsed.limit,
            snippet: parsed.snippet
        })
        console.log(formatSessionContext(parsed.sessionId, result.messages, parsed))
        return
    }

    // Fetch backwards until enough semantic user turns are present. Raw history
    // contains many usage/event rows, so one 200-row page is not always enough.
    for (let page = 0; page < 5; page += 1) {
        const result = await api.getSessionHistory(parsed.sessionId, beforeSeq === undefined
            ? { tail: 200 }
            : { beforeSeq, limit: 200 })
        if (result.messages.length === 0) break
        messages.unshift(...result.messages)
        if (countContextTurns(messages) >= parsed.turns) break
        const earliestSeq = result.messages[0]?.seq
        if (earliestSeq === null || earliestSeq === undefined || earliestSeq <= 1) break
        beforeSeq = earliestSeq
        if (result.messages.length < 200) break
    }

    console.log(formatSessionContext(parsed.sessionId, messages, parsed))
}

async function runInspect(args: string[]): Promise<void> {
    const parsed = parseSessionInspectArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    const messages: SessionHistoryMessage[] = []
    let afterSeq = parsed.seq - 1
    let inspections = [] as ReturnType<typeof inspectToolCalls>

    for (let page = 0; page < 5; page += 1) {
        const result = await api.getSessionHistory(parsed.sessionId, { afterSeq, limit: 200 })
        if (result.messages.length === 0) break
        messages.push(...result.messages)
        inspections = inspectToolCalls(messages, parsed.seq)
        if (inspections.length > 0 && inspections.every(item => item.resultSeq !== null)) break
        const lastSeq = result.messages.at(-1)?.seq
        if (lastSeq === null || lastSeq === undefined || lastSeq <= afterSeq || result.messages.length < 200) break
        afterSeq = lastSeq
    }

    if (inspections.length === 0) {
        throw new Error(`No tool call found at seq ${parsed.seq}`)
    }
    if (parsed.raw) {
        console.log(JSON.stringify({ messages: rawInspectionMessages(messages, inspections) }, null, 2))
    } else if (parsed.format === 'json') {
        console.log(JSON.stringify({ tools: inspections }, null, 2))
    } else {
        console.log(formatToolInspections(inspections))
    }
}

async function runCreate(args: string[]): Promise<void> {
    const parsed = parseCreateArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    const parent = await api.getSession(parsed.parentSessionId)
    const metadata = deriveChildMetadata(parent, parsed)
    const session = await api.getOrCreateSession({
        tag: parsed.tag ?? `session-create-${randomUUID()}`,
        metadata,
        state: null,
        parentSessionId: parsed.parentSessionId
    })

    if (parsed.format === 'json') {
        console.log(JSON.stringify({ session }, null, 2))
        return
    }

    console.log(chalk.green('Created session:'), session.id)
    console.log(chalk.gray(`parent: ${session.parentSessionId ?? parsed.parentSessionId}`))
    console.log(chalk.gray(`path: ${metadata.path}`))
}

async function runSetTitle(args: string[]): Promise<void> {
    const parsed = parseSetTitleArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    await api.renameSession(parsed.sessionId, parsed.title)

    if (parsed.format === 'json') {
        console.log(JSON.stringify({
            ok: true,
            sessionId: parsed.sessionId,
            title: parsed.title
        }, null, 2))
        return
    }

    console.log('ok')
}

async function runSetSummary(args: string[]): Promise<void> {
    const parsed = parseSetSummaryArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    await api.setSessionSummary(parsed.sessionId, parsed.title)
    if (parsed.format === 'json') {
        console.log(JSON.stringify({ ok: true, sessionId: parsed.sessionId, summary: parsed.title }, null, 2))
        return
    }
    console.log('ok')
}

async function runExport(args: string[]): Promise<void> {
    const parsed = parseExportArgs(args)
    await initializeToken()
    const api = await ApiClient.create()
    const exported = await api.exportSession(parsed.sessionId)
    const json = JSON.stringify(exported, null, 2)

    if (parsed.outputPath) {
        await writeFile(parsed.outputPath, `${json}\n`, 'utf-8')
        console.error(chalk.green(`Exported session ${parsed.sessionId} → ${parsed.outputPath}`))
        return
    }

    console.log(json)
}

function isHelpArg(arg: string | undefined): boolean {
    return arg === undefined
        || arg === ''
        || arg === 'help'
        || arg === '--help'
        || arg === '-h'
}

export const sessionCommand: CommandDefinition = {
    name: 'session',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        const subcommand = commandArgs[0] as SessionSubcommand | string | undefined
        try {
            // Usage / help is a successful no-op (exit 0), not an error.
            if (isHelpArg(subcommand) || commandArgs.includes('--help') || commandArgs.includes('-h')) {
                printUsage()
                return
            }
            if (subcommand === 'history') {
                await runHistory(commandArgs)
                return
            }
            if (subcommand === 'context') {
                await runContext(commandArgs)
                return
            }
            if (subcommand === 'inspect') {
                await runInspect(commandArgs)
                return
            }
            if (subcommand === 'create') {
                await runCreate(commandArgs)
                return
            }
            if (subcommand === 'set-title') {
                await runSetTitle(commandArgs)
                return
            }
            if (subcommand === 'set-summary') {
                await runSetSummary(commandArgs)
                return
            }
            if (subcommand === 'export') {
                await runExport(commandArgs)
                return
            }

            console.error(chalk.red('Error:'), `Unknown session subcommand: ${subcommand}`)
            printUsage()
            process.exitCode = 1
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            printUsage()
            process.exit(1)
        }
    }
}
