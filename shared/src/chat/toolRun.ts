import { isObject } from '../utils'
import { normalizeDecryptedMessage } from './normalize'
import type {
    ChatSourceMessage,
    NormalizedMessage,
    ToolGroupContent,
    ToolGroupToolDescriptor,
    UsageData
} from './types'

/**
 * Tool names that always render as a standalone card and therefore end a tool run.
 * Kept here (not in the web package) so the hub splits pages exactly where the
 * client draws group boundaries.
 */
const NON_GROUPABLE_TOOL_NAMES = new Set([
    // Plan / todo milestones
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning',
    // Interactive prompts
    'CodexPermission',
    'AskUserQuestion',
    'ask_user_question',
    'request_user_input',
    // Team structure changes
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    // Rendered as a "title changed" event, not a tool card
    'mcp__hapi__change_title',
    'hapi__change_title'
])

export function isGroupableToolName(name: string): boolean {
    return !NON_GROUPABLE_TOOL_NAMES.has(name)
}

/**
 * Subagent tools own a nested transcript that the client attaches by the id of
 * the message carrying the tool call. Compacting that message away would orphan
 * the transcript, so runs containing one are delivered raw.
 */
function isSubagentToolName(name: string): boolean {
    return name === 'Task'
        || name === 'Agent'
        || name.startsWith('Task:')
        || name.startsWith('Agent:')
        || name === 'CodexAgent'
}

/**
 * Role of a stored message inside a tool run.
 *
 * - `boundary`    — renders as its own timeline unit; a page may be cut here.
 * - `tool`        — a tool call or result that packs into a tool group card.
 * - `transparent` — renders nothing on its own (reasoning, usage-only, sidechain).
 *
 * The classification is deliberately conservative: anything the client *might*
 * pack into a group is reported as `tool`, so a run computed here is always a
 * superset of the client's group. Cutting a page outside such a run can then
 * never fall inside a rendered group.
 */
export type ToolRunKind = 'boundary' | 'tool' | 'transparent'

export function classifyNormalizedForToolRun(normalized: NormalizedMessage | null): ToolRunKind {
    if (!normalized) return 'transparent'
    // Subagent transcripts render inside their parent Task card, never inline.
    if (normalized.isSidechain) return 'transparent'
    if (normalized.role === 'user') return 'boundary'
    if (normalized.role === 'event') return 'boundary'

    let sawTool = false
    for (const part of normalized.content) {
        if (part.type === 'text') {
            if (part.text.trim().length > 0) return 'boundary'
            continue
        }
        if (part.type === 'summary') return 'boundary'
        if (part.type === 'tool-group') return 'boundary'
        if (part.type === 'tool-call') {
            if (!isGroupableToolName(part.name)) return 'boundary'
            sawTool = true
            continue
        }
        if (part.type === 'tool-result') {
            sawTool = true
        }
    }
    return sawTool ? 'tool' : 'transparent'
}

export function classifyToolRunMessage(message: ChatSourceMessage): ToolRunKind {
    return classifyNormalizedForToolRun(normalizeDecryptedMessage(message))
}

/** Index range of a maximal run of consecutive tool activity. */
export type ToolRunSpan = {
    /** First index of the run (inclusive). */
    start: number
    /** Last index of the run (inclusive); always a `tool` message. */
    end: number
}

/**
 * Split a classified, seq-ordered message list into maximal tool runs.
 * Leading/trailing `transparent` messages are excluded so a run always begins
 * and ends on real tool activity.
 */
export function findToolRuns(kinds: readonly ToolRunKind[]): ToolRunSpan[] {
    const runs: ToolRunSpan[] = []
    let start = -1
    let end = -1

    const flush = () => {
        if (start >= 0 && end >= start) {
            runs.push({ start, end })
        }
        start = -1
        end = -1
    }

    for (let index = 0; index < kinds.length; index += 1) {
        const kind = kinds[index]
        if (kind === 'boundary') {
            flush()
            continue
        }
        if (kind === 'tool') {
            if (start < 0) start = index
            end = index
        }
    }
    flush()
    return runs
}

// ---------------------------------------------------------------------------
// Compacted tool-group message
// ---------------------------------------------------------------------------

/** Longest string kept inside a compacted tool input. */
const MAX_INPUT_STRING_LENGTH = 600
const MAX_INPUT_ARRAY_ITEMS = 20
const MAX_INPUT_DEPTH = 5
const TRUNCATION_SUFFIX = '…'

/**
 * Shrink a tool input to what a group row needs (paths, commands, patterns)
 * while dropping bulky payloads such as file bodies in Write/Edit inputs.
 */
export function truncateToolInput(input: unknown, depth = 0): unknown {
    if (typeof input === 'string') {
        return input.length > MAX_INPUT_STRING_LENGTH
            ? `${input.slice(0, MAX_INPUT_STRING_LENGTH)}${TRUNCATION_SUFFIX}`
            : input
    }
    if (input === null || typeof input !== 'object') return input
    if (depth >= MAX_INPUT_DEPTH) return undefined

    if (Array.isArray(input)) {
        return input
            .slice(0, MAX_INPUT_ARRAY_ITEMS)
            .map((item) => truncateToolInput(item, depth + 1))
    }

    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        const truncated = truncateToolInput(value, depth + 1)
        if (truncated !== undefined) output[key] = truncated
    }
    return output
}

export function buildToolGroupId(firstToolUseId: string): string {
    return `tool-group:${firstToolUseId}`
}

/**
 * Collapse the tool calls of one run into descriptors. Returns `null` when the
 * run does not form a group on the client (fewer than two groupable tools).
 */
/**
 * Token usage of the messages a group replaces, summed so the context and cost
 * readouts stay correct. Claude reports usage on the very assistant messages
 * that carry the tool calls, so dropping it would under-report every tool run.
 */
function addUsage(total: UsageData | null, usage: UsageData): UsageData {
    if (!total) {
        return {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens
        }
    }
    return {
        input_tokens: total.input_tokens + usage.input_tokens,
        output_tokens: total.output_tokens + usage.output_tokens,
        cache_creation_input_tokens: (total.cache_creation_input_tokens ?? 0)
            + (usage.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens: (total.cache_read_input_tokens ?? 0)
            + (usage.cache_read_input_tokens ?? 0)
    }
}

export type ToolGroupCollection = {
    tools: ToolGroupToolDescriptor[]
    usage: UsageData | null
    model: string | null
    /**
     * Seqs of the messages the group stands for. Everything else in the span —
     * reasoning, usage-only messages, and results whose call was announced
     * alongside prose (and so renders on its own) — must survive untouched.
     */
    absorbedSeqs: number[]
}

/**
 * Collapse the tool calls of one run into descriptors. Returns `null` when the
 * run must not be compacted: fewer than two groupable tools, or a subagent tool
 * whose nested transcript would be orphaned.
 */
export function collectToolGroupDescriptors(
    messages: readonly ChatSourceMessage[]
): ToolGroupCollection | null {
    type AgentEntry = { seq: number; normalized: NormalizedMessage & { role: 'agent' } }
    const normalized = messages
        .map((message) => ({ seq: message.seq, normalized: normalizeDecryptedMessage(message) }))
        .filter((entry): entry is AgentEntry => (
            typeof entry.seq === 'number' && entry.normalized !== null && entry.normalized.role === 'agent'
        ))

    const byId = new Map<string, ToolGroupToolDescriptor>()
    for (const { normalized: message } of normalized) {
        for (const part of message.content) {
            if (part.type !== 'tool-call') continue
            if (isSubagentToolName(part.name)) return null
            const existing = byId.get(part.id)
            if (existing) {
                existing.name = part.name
                existing.input = truncateToolInput(part.input)
                existing.description = part.description
                continue
            }
            byId.set(part.id, {
                id: part.id,
                name: part.name,
                input: truncateToolInput(part.input),
                description: part.description,
                state: 'running',
                createdAt: message.createdAt,
                startedAt: message.createdAt,
                completedAt: null,
                resultPending: true
            })
        }
    }
    if (byId.size < 2) return null

    const absorbedSeqs: number[] = []
    const countedUsageIds = new Set<string>()
    let usage: UsageData | null = null
    let model: string | null = null

    for (const { seq, normalized: message } of normalized) {
        let toolParts = 0
        let allFolded = true
        for (const part of message.content) {
            if (part.type === 'tool-call') {
                toolParts += 1
                if (!byId.has(part.id)) allFolded = false
                continue
            }
            if (part.type === 'tool-result') {
                toolParts += 1
                const existing = byId.get(part.tool_use_id)
                if (!existing) {
                    allFolded = false
                    continue
                }
                existing.state = part.is_error ? 'error' : 'completed'
                existing.completedAt = message.createdAt
            }
        }
        if (toolParts === 0 || !allFolded) continue

        absorbedSeqs.push(seq)
        // Cumulative turn totals ride on messages that stay in the page; only
        // increments carried by absorbed messages need folding into the group.
        if (message.usage && message.usage.total_tokens === undefined) {
            const usageId = message.usage.usage_id
            if (!usageId || !countedUsageIds.has(usageId)) {
                if (usageId) countedUsageIds.add(usageId)
                usage = addUsage(usage, message.usage)
            }
        }
        if (message.model) model = message.model
    }

    if (absorbedSeqs.length === 0) return null
    return { tools: [...byId.values()], usage, model, absorbedSeqs }
}

export function buildToolGroupContent(collection: ToolGroupCollection): ToolGroupContent {
    return {
        type: 'tool-group',
        groupId: buildToolGroupId(collection.tools[0].id),
        firstSeq: Math.min(...collection.absorbedSeqs),
        lastSeq: Math.max(...collection.absorbedSeqs),
        absorbedSeqs: collection.absorbedSeqs,
        tools: collection.tools,
        ...(collection.usage ? { usage: collection.usage } : {}),
        ...(collection.model ? { model: collection.model } : {})
    }
}

/** Seqs a compacted tool-group message stands for, or null for other messages. */
export function getToolGroupAbsorbedSeqs(content: unknown): number[] | null {
    if (!isObject(content) || content.role !== 'agent') return null
    const inner = content.content
    if (!isObject(inner) || inner.type !== 'tool-group') return null
    return Array.isArray(inner.absorbedSeqs)
        ? inner.absorbedSeqs.filter((seq): seq is number => typeof seq === 'number')
        : []
}

/** Reads the seq span of a compacted tool-group message envelope. */
export function getToolGroupSpan(content: unknown): { firstSeq: number; lastSeq: number } | null {
    if (!isObject(content) || content.role !== 'agent') return null
    const inner = content.content
    if (!isObject(inner) || inner.type !== 'tool-group') return null
    const firstSeq = inner.firstSeq
    const lastSeq = inner.lastSeq
    if (typeof firstSeq !== 'number' || typeof lastSeq !== 'number') return null
    return { firstSeq, lastSeq }
}
