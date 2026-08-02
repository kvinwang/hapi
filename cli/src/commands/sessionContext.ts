import { normalizeDecryptedMessage, type ChatSourceMessage, type NormalizedMessage } from '@hapi/protocol/chat'
import type { SessionHistoryMessage } from '@/api/types'

export type ContextToolMode = 'none' | 'summary' | 'full'

export type SessionContextArgs = {
    sessionId: string
    turns: number
    maxChars: number
    tools: ContextToolMode
}

type ContextEntry = {
    firstSeq: number | null
    lastSeq: number | null
    kind: 'user' | 'assistant' | 'event' | 'tool'
    text: string
    toolResult?: string
    toolError?: boolean
}

function optionValue(args: string[], arg: string, index: number): { value: string; nextIndex: number } {
    const separator = arg.indexOf('=')
    if (separator >= 0) return { value: arg.slice(separator + 1), nextIndex: index }
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    return { value, nextIndex: index + 1 }
}

function positiveInteger(raw: string, option: string, max: number): number {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(`${option} must be an integer between 1 and ${max}`)
    }
    return value
}

export function parseSessionContextArgs(args: string[], environment: NodeJS.ProcessEnv = process.env): SessionContextArgs {
    let sessionId = environment.HAPI_SESSION_ID?.trim() ?? ''
    let turns = 20
    let maxChars = 16_000
    let tools: ContextToolMode = 'summary'

    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--session' || arg === '-s' || arg.startsWith('--session=')) {
            const parsed = optionValue(args, arg, index)
            sessionId = parsed.value.trim()
            index = parsed.nextIndex
            continue
        }
        if (arg === '--turns' || arg.startsWith('--turns=')) {
            const parsed = optionValue(args, arg, index)
            turns = positiveInteger(parsed.value, '--turns', 100)
            index = parsed.nextIndex
            continue
        }
        if (arg === '--max-chars' || arg.startsWith('--max-chars=')) {
            const parsed = optionValue(args, arg, index)
            maxChars = positiveInteger(parsed.value, '--max-chars', 100_000)
            index = parsed.nextIndex
            continue
        }
        if (arg === '--tools' || arg.startsWith('--tools=')) {
            const parsed = optionValue(args, arg, index)
            if (parsed.value !== 'none' && parsed.value !== 'summary' && parsed.value !== 'full') {
                throw new Error('--tools must be one of: none, summary, full')
            }
            tools = parsed.value
            index = parsed.nextIndex
            continue
        }
        throw new Error(`Unknown option: ${arg}`)
    }

    if (!sessionId) {
        throw new Error('Missing session ID. Set HAPI_SESSION_ID or pass --session <id>')
    }
    return { sessionId, turns, maxChars, tools }
}

function stringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return '[unserializable]'
    }
}

function compactWhitespace(value: string): string {
    return value.replace(/\r\n?/g, '\n').trim()
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value
    return `${value.slice(0, Math.max(0, limit - 1))}…`
}

function toolInputSummary(name: string, input: unknown, full: boolean): string {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const record = input as Record<string, unknown>
        for (const key of ['command', 'cmd', 'file_path', 'path', 'query', 'pattern', 'url', 'prompt']) {
            const value = record[key]
            if (typeof value === 'string' && value.trim()) {
                return `${name}: ${full ? compactWhitespace(value) : truncate(compactWhitespace(value), 500)}`
            }
        }
    }
    const serialized = compactWhitespace(stringify(input))
    return serialized ? `${name}: ${full ? serialized : truncate(serialized, 500)}` : name
}

function importantEvent(message: NormalizedMessage & { role: 'event' }): string | null {
    const event = message.content
    if (event.type === 'message' && typeof event.message === 'string') return event.message
    if (event.type === 'api-error') return `API error (attempt ${event.retryAttempt}/${event.maxRetries})`
    if (event.type === 'compact') return `Context compacted (${event.trigger})`
    if (event.type === 'microcompact') return `Context compacted (${event.trigger})`
    if (event.type === 'limit-reached') return `Limit reached: ${event.limitType}`
    return null
}

function normalizeHistoryMessage(message: SessionHistoryMessage): NormalizedMessage | null {
    return normalizeDecryptedMessage({
        id: message.id,
        seq: message.seq,
        createdAt: message.createdAt,
        localId: message.localId ?? null,
        content: message.content
    } as ChatSourceMessage)
}

export function countContextTurns(messages: SessionHistoryMessage[]): number {
    let count = 0
    for (const message of messages) {
        if (normalizeHistoryMessage(message)?.role === 'user') count += 1
    }
    return count
}

function buildEntries(messages: SessionHistoryMessage[], tools: ContextToolMode): ContextEntry[] {
    const entries: ContextEntry[] = []
    const toolEntries = new Map<string, ContextEntry>()

    for (const raw of messages) {
        const message = normalizeHistoryMessage(raw)
        if (!message) continue
        const seq = message.seq ?? null

        if (message.role === 'user') {
            const text = compactWhitespace(message.content.text)
            if (text) entries.push({ firstSeq: seq, lastSeq: seq, kind: 'user', text })
            continue
        }
        if (message.role === 'event') {
            const text = importantEvent(message)
            if (text) entries.push({ firstSeq: seq, lastSeq: seq, kind: 'event', text })
            continue
        }

        for (const part of message.content) {
            if (part.type === 'text') {
                const text = compactWhitespace(part.text)
                if (text) entries.push({ firstSeq: seq, lastSeq: seq, kind: 'assistant', text })
                continue
            }
            if (part.type === 'summary') {
                const text = compactWhitespace(part.summary)
                if (text) entries.push({ firstSeq: seq, lastSeq: seq, kind: 'event', text: `Summary: ${text}` })
                continue
            }
            if (tools === 'none') continue
            if (part.type === 'tool-call') {
                const entry: ContextEntry = {
                    firstSeq: seq,
                    lastSeq: seq,
                    kind: 'tool',
                    text: toolInputSummary(part.name, part.input, tools === 'full')
                }
                entries.push(entry)
                toolEntries.set(part.id, entry)
                continue
            }
            if (part.type === 'tool-result') {
                const entry = toolEntries.get(part.tool_use_id)
                if (!entry) continue
                entry.lastSeq = seq
                entry.toolError = part.is_error
                const result = compactWhitespace(stringify(part.content))
                entry.toolResult = tools === 'full' ? result : truncate(result, 800)
            }
        }
    }
    return entries
}

function seqLabel(entry: ContextEntry): string {
    const first = entry.firstSeq ?? '-'
    const last = entry.lastSeq ?? first
    return first === last ? String(first) : `${first}–${last}`
}

function renderEntry(entry: ContextEntry): string {
    const label = entry.kind === 'user'
        ? 'User'
        : entry.kind === 'assistant'
            ? 'Assistant'
            : entry.kind === 'event'
                ? 'Event'
                : `Tool${entry.toolError ? ' [failed]' : ''}`
    const result = entry.toolResult ? `\nResult: ${entry.toolResult}` : ''
    return `[${seqLabel(entry)}] ${label}:\n${entry.text}${result}`
}

export function formatSessionContext(
    sessionId: string,
    messages: SessionHistoryMessage[],
    options: Pick<SessionContextArgs, 'turns' | 'maxChars' | 'tools'>
): string {
    let entries = buildEntries(messages, options.tools)
    const userIndexes = entries.flatMap((entry, index) => entry.kind === 'user' ? [index] : [])
    if (userIndexes.length > options.turns) {
        entries = entries.slice(userIndexes[userIndexes.length - options.turns])
    }

    const header = `Session: ${sessionId}`
    const rendered = entries.map(renderEntry)
    const selected: string[] = []
    let used = header.length
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
        const cost = rendered[index].length + 2
        if (selected.length > 0 && used + cost > options.maxChars) break
        selected.unshift(rendered[index])
        used += cost
    }
    const omitted = rendered.length - selected.length
    const notice = omitted > 0 ? `\n[${omitted} older semantic entries omitted]\n` : ''
    return `${header}${notice}\n\n${selected.join('\n\n')}`.trimEnd()
}
