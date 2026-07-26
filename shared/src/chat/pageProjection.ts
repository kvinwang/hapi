import { isObject } from '../utils'
import { classifyToolRunMessage } from './toolRun'
import type { ChatSourceMessage, ToolGroupToolDescriptor } from './types'

/**
 * What a history page has to carry, and nothing else.
 *
 * The page feeds one screen of chat. Everything it holds is either drawn or
 * used to place what is drawn; the full record stays in storage and comes back
 * through the tool-group expansion endpoint when the reader opens a card. On a
 * real page this cuts the payload to a sixth, and most of what goes is a single
 * field: the signature of a thinking block nothing renders.
 */

/** Longest display string kept on a projected tool input. */
const MAX_DISPLAY_STRING = 200
/** Array items are replaced by placeholders; only the count is ever read. */
const MAX_ARRAY_PLACEHOLDERS = 100

/** Input keys a tool card reads for its title, subtitle or path badge. */
const DISPLAY_KEYS = new Set([
    'command', 'cmd', 'variant',
    'file_path', 'path', 'filePath', 'file', 'notebook_path',
    'pattern', 'url', 'query', 'prompt', 'description',
    'name', 'team_name', 'subagent_type', 'skill', 'title'
])

/** `data.type` values the client can turn into something visible. */
const RENDERABLE_DATA_TYPES = new Set([
    'assistant', 'result', 'user', 'summary', 'system',
    'message', 'usage', 'token_count', 'reasoning', 'tool-call', 'tool-call-result'
])

function truncate(value: string): string {
    return value.length > MAX_DISPLAY_STRING ? `${value.slice(0, MAX_DISPLAY_STRING)}…` : value
}

/**
 * Shrink a tool input to what the collapsed row draws. Bodies (file contents,
 * patch text) go; paths, commands and patterns stay. Arrays keep their length
 * because a card may count them ("3 edits") but never reads the items.
 */
export function projectToolInputForDisplay(input: unknown): unknown {
    if (!isObject(input)) return undefined
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') {
            if (value.length <= MAX_DISPLAY_STRING) output[key] = value
            else if (DISPLAY_KEYS.has(key)) output[key] = truncate(value)
            continue
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            output[key] = value
            continue
        }
        if (Array.isArray(value)) {
            output[key] = new Array(Math.min(value.length, MAX_ARRAY_PLACEHOLDERS)).fill(null)
        }
    }
    return Object.keys(output).length > 0 ? output : undefined
}

/**
 * A finished tool shows a status, a label and nothing else; only a running one
 * shows a clock, and `completedAt` is never drawn at all.
 */
export function projectToolDescriptor(tool: ToolGroupToolDescriptor): ToolGroupToolDescriptor {
    const projected: ToolGroupToolDescriptor = {
        id: tool.id,
        name: tool.name,
        state: tool.state
    }
    const input = projectToolInputForDisplay(tool.input)
    if (input !== undefined) projected.input = input
    if (tool.description) projected.description = tool.description
    if (tool.state === 'running') projected.startedAt = tool.startedAt ?? tool.createdAt ?? null
    if (tool.resultPending) projected.resultPending = true
    return projected
}

function projectContentBlock(block: unknown): unknown | null {
    if (!isObject(block) || typeof block.type !== 'string') return null
    if (block.type === 'text') {
        return typeof block.text === 'string' ? { type: 'text', text: block.text } : null
    }
    if (block.type === 'thinking') {
        // The signature only matters when replaying the turn to the model, which
        // the agent does from its own transcript. Empty reasoning draws nothing.
        return typeof block.thinking === 'string' && block.thinking.length > 0
            ? { type: 'thinking', thinking: block.thinking }
            : null
    }
    if (block.type === 'tool_use') {
        return typeof block.id === 'string'
            ? { type: 'tool_use', id: block.id, name: block.name, input: block.input }
            : null
    }
    if (block.type === 'tool_result') {
        return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            ...(block.is_error === true ? { is_error: true } : {})
        }
    }
    return block
}

const USAGE_KEYS = [
    'input_tokens', 'output_tokens',
    'cache_creation_input_tokens', 'cache_read_input_tokens',
    'service_tier',
    'total_tokens', 'total_input_tokens', 'total_output_tokens',
    'total_cached_input_tokens', 'total_reasoning_output_tokens',
    'context_tokens'
]

const DATA_KEYS = [
    'type', 'subtype', 'summary',
    'modelUsage', 'total_cost_usd',
    'retryAttempt', 'maxRetries', 'durationMs', 'trigger', 'preTokens', 'tokensSaved',
    'callId', 'name', 'input', 'id', 'info', 'message'
]

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    const output: Record<string, unknown> = {}
    for (const key of keys) if (source[key] !== undefined) output[key] = source[key]
    return output
}

export type PageProjectionOptions = {
    /** Working directory of the session; a message only carries its own when it differs. */
    sessionCwd?: string | null
}

function projectAgentData(data: Record<string, unknown>, options: PageProjectionOptions): Record<string, unknown> | null {
    const type = typeof data.type === 'string' ? data.type : null
    if (!type || !RENDERABLE_DATA_TYPES.has(type)) return null
    // The client drops these before rendering; no reason to send them.
    if (data.isMeta === true || data.isCompactSummary === true) return null

    const output = pick(data, DATA_KEYS)

    // Sidechain transcripts are stitched together by uuid; nothing else reads it.
    if (data.isSidechain === true) {
        output.isSidechain = true
        if (typeof data.uuid === 'string') output.uuid = data.uuid
        if (typeof data.parentUuid === 'string') output.parentUuid = data.parentUuid
    }

    // Worth knowing only where it differs from the session's own directory —
    // a worktree, a second repo, a resumed session on another machine.
    if (typeof data.cwd === 'string' && data.cwd !== options.sessionCwd) {
        output.cwd = data.cwd
    }

    if (isObject(data.message)) {
        const message = pick(data.message, ['model', 'id', 'content'])
        if (Array.isArray(data.message.content)) {
            message.content = data.message.content
                .map(projectContentBlock)
                .filter((block): block is Record<string, unknown> => block !== null)
        }
        if (isObject(data.message.usage)) {
            message.usage = pick(data.message.usage, USAGE_KEYS)
        }
        // An assistant turn with nothing left to draw and no tokens to count.
        if (
            type === 'assistant'
            && Array.isArray(message.content)
            && message.content.length === 0
            && message.usage === undefined
        ) {
            return null
        }
        output.message = message
    }

    return output
}

/** Usage-only assistant message: no blocks to draw, just tokens to count. */
function usageOnlyIncrement(message: ChatSourceMessage): Record<string, unknown> | null {
    const content = message.content
    if (!isObject(content) || content.role !== 'agent') return null
    const inner = content.content
    if (!isObject(inner) || inner.type !== 'output') return null
    const data = inner.data
    if (!isObject(data) || data.type !== 'assistant') return null
    const inner_message = data.message
    if (!isObject(inner_message)) return null
    if (!Array.isArray(inner_message.content) || inner_message.content.length > 0) return null
    const usage = inner_message.usage
    if (!isObject(usage) || usage.total_tokens !== undefined) return null
    return usage
}

function withUsage(message: ChatSourceMessage, usage: Record<string, unknown>): ChatSourceMessage {
    const content = message.content as Record<string, unknown>
    const inner = content.content as Record<string, unknown>
    const data = inner.data as Record<string, unknown>
    const innerMessage = data.message as Record<string, unknown>
    return {
        ...message,
        content: {
            ...content,
            content: { ...inner, data: { ...data, message: { ...innerMessage, usage } } }
        }
    }
}

/** One message, stripped to what the page needs. Null means "do not send". */
export function projectPageMessage(
    message: ChatSourceMessage,
    options: PageProjectionOptions = {}
): ChatSourceMessage | null {
    const content = message.content
    if (!isObject(content)) return message

    const envelope = {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        createdAt: message.createdAt
    }
    // Only sentFrom is read, and only to spot CLI output.
    const meta = isObject(content.meta) && typeof content.meta.sentFrom === 'string'
        ? { sentFrom: content.meta.sentFrom }
        : undefined

    const inner = content.content
    if (content.role === 'agent' && isObject(inner) && inner.type === 'tool-group') {
        const tools = Array.isArray(inner.tools)
            ? (inner.tools as ToolGroupToolDescriptor[]).map(projectToolDescriptor)
            : inner.tools
        return {
            ...envelope,
            content: { role: 'agent', content: { ...inner, tools }, ...(meta ? { meta } : {}) }
        }
    }

    if (content.role === 'agent' && isObject(inner) && (inner.type === 'output' || inner.type === 'codex')) {
        if (!isObject(inner.data)) return null
        const data = projectAgentData(inner.data, options)
        if (!data) return null
        return {
            ...envelope,
            content: { role: 'agent', content: { type: inner.type, data }, ...(meta ? { meta } : {}) }
        }
    }

    return { ...envelope, content: { ...content, ...(meta ? { meta } : {}) } }
}

/**
 * Project a whole page, then fold runs of usage-only messages.
 *
 * The cost readout sums every increment and the context readout reads the
 * newest one, so a run of them collapses to two: the first carries the sum of
 * everything before the last, and the last stays untouched.
 */
export function projectMessagesPage(
    messages: readonly ChatSourceMessage[],
    options: PageProjectionOptions = {}
): ChatSourceMessage[] {
    const projected: ChatSourceMessage[] = []
    for (const message of messages) {
        const next = projectPageMessage(message, options)
        if (next) projected.push(next)
    }

    const output: ChatSourceMessage[] = []
    for (let index = 0; index < projected.length; index += 1) {
        const increment = usageOnlyIncrement(projected[index])
        if (!increment) {
            output.push(projected[index])
            continue
        }
        let end = index
        while (end + 1 < projected.length && usageOnlyIncrement(projected[end + 1])) end += 1
        if (end - index < 2) {
            for (let i = index; i <= end; i += 1) output.push(projected[i])
            index = end
            continue
        }
        const summed: Record<string, number> = {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
        }
        for (let i = index; i < end; i += 1) {
            const usage = usageOnlyIncrement(projected[i]) ?? {}
            for (const key of Object.keys(summed)) {
                summed[key] += typeof usage[key] === 'number' ? (usage[key] as number) : 0
            }
        }
        output.push(withUsage(projected[index], summed))
        output.push(projected[end])
        index = end
    }
    return output
}

/** Messages a page would drop entirely — exported for the hub's page bookkeeping. */
export function isDroppedByPageProjection(message: ChatSourceMessage): boolean {
    return projectPageMessage(message) === null && classifyToolRunMessage(message) !== 'tool'
}
