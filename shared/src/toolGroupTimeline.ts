import { isObject } from './utils'

export type ToolGroupActionKind = 'read' | 'search' | 'command' | 'mutation' | 'web' | 'other'

export type ToolGroupTimelineSummary = {
    totalTools: number
    countsByKind: Record<ToolGroupActionKind, number>
    fileTargets: string[]
    commandTargets: string[]
    searchTargets: string[]
    urlTargets: string[]
    otherTargets: string[]
    errorCount: number
    runningCount: number
    pendingCount: number
}

export type ToolGroupTimelineEntry = {
    id: string
    firstSeq: number
    lastSeq: number
    firstMessageId: string
    lastMessageId: string
    createdAt: number
    sealed: true
    toolUseIds: string[]
    summary: ToolGroupTimelineSummary
    toolsPreview: Array<{
        id: string
        name: string
        state: 'pending' | 'running' | 'completed' | 'error'
    }>
}

export type TimelineMessage = {
    id: string
    seq: number
    createdAt: number
    localId?: string | null
    content: unknown
}

type Classified =
    | { kind: 'boundary' }
    | { kind: 'transparent' }
    | {
        kind: 'tool'
        toolUseId: string
        name: string
        phase: 'start' | 'result' | 'update'
        state: 'pending' | 'running' | 'completed' | 'error'
        input?: unknown
    }

const PLAN_TOOL_NAMES = new Set([
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning'
])

const INTERACTIVE_TOOL_NAMES = new Set([
    'CodexPermission',
    'AskUserQuestion',
    'RequestUserInput',
    'request_user_input'
])

function nameLooksLike(name: string, prefixes: string[]): boolean {
    const lower = name.trim().toLowerCase()
    return prefixes.some((prefix) => (
        lower === prefix
        || lower.startsWith(`${prefix} `)
        || lower.startsWith(`${prefix}\``)
        || lower.startsWith(`${prefix}_`)
    ))
}

export function getToolGroupActionKindFromName(name: string, input?: unknown): ToolGroupActionKind {
    const lower = name.trim().toLowerCase()
    if (nameLooksLike(name, ['task', 'agent']) || name === 'CodexAgent') return 'other'
    if (
        name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit'
        || name === 'CodexPatch' || name === 'CodexDiff' || name === 'search_replace'
        || name === 'str_replace' || name === 'write_file'
        || nameLooksLike(name, ['edit', 'write', 'patch', 'delete', 'replace'])
    ) return 'mutation'
    if (name === 'Read' || name === 'NotebookRead' || name === 'read_file' || nameLooksLike(name, ['read', 'view', 'cat', 'open'])) {
        return 'read'
    }
    if (
        name === 'Grep' || name === 'Glob' || name === 'LS'
        || name === 'search_file_content' || name === 'list_directory'
        || nameLooksLike(name, ['grep', 'glob', 'find', 'list'])
        || (nameLooksLike(name, ['search']) && !lower.includes('replace'))
    ) return 'search'
    if (
        name === 'Bash' || name === 'CodexBash' || name === 'shell_command'
        || name === 'run_terminal_command' || name === 'run_terminal_cmd'
        || nameLooksLike(name, ['bash', 'shell', 'terminal', 'execute', 'run'])
    ) return 'command'
    if (
        name === 'WebFetch' || name === 'WebSearch'
        || nameLooksLike(name, ['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch', 'browse'])
    ) return 'web'
    void input
    return 'other'
}

function isHardBoundaryToolName(name: string): boolean {
    return PLAN_TOOL_NAMES.has(name)
        || INTERACTIVE_TOOL_NAMES.has(name)
        || name === 'TeamCreate'
        || name === 'TeamDelete'
        || name === 'SendMessage'
}

function collectObjects(value: unknown, depth = 0, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (depth > 8 || value === null || value === undefined) return out
    if (Array.isArray(value)) {
        for (const entry of value) collectObjects(entry, depth + 1, out)
        return out
    }
    if (!isObject(value)) return out
    out.push(value)
    for (const nested of Object.values(value)) {
        if (isObject(nested) || Array.isArray(nested)) {
            collectObjects(nested, depth + 1, out)
        }
    }
    return out
}

function hasVisibleText(content: unknown): boolean {
    for (const obj of collectObjects(content)) {
        const type = typeof obj.type === 'string' ? obj.type : ''
        if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof obj.text === 'string' && obj.text.trim()) {
            return true
        }
        if (type === 'reasoning' || type === 'thinking') {
            // transparent alone
            continue
        }
    }
    return false
}

function extractToolEvents(content: unknown): Classified[] {
    const events: Classified[] = []
    const objects = collectObjects(content)

    for (const obj of objects) {
        const type = typeof obj.type === 'string' ? obj.type : ''

        // Claude tool_use
        if (type === 'tool_use' && typeof obj.id === 'string') {
            const name = typeof obj.name === 'string' ? obj.name : 'tool'
            if (isHardBoundaryToolName(name)) {
                return [{ kind: 'boundary' }]
            }
            events.push({
                kind: 'tool',
                toolUseId: obj.id,
                name,
                phase: 'start',
                state: 'running',
                input: obj.input
            })
            continue
        }

        // Claude tool_result
        if (type === 'tool_result' && typeof obj.tool_use_id === 'string') {
            const isError = obj.is_error === true
            events.push({
                kind: 'tool',
                toolUseId: obj.tool_use_id,
                name: 'tool',
                phase: 'result',
                state: isError ? 'error' : 'completed'
            })
            continue
        }

        // Codex / generic tool-call
        if ((type === 'tool-call' || type === 'tool_call') && (typeof obj.callId === 'string' || typeof obj.id === 'string')) {
            const toolUseId = typeof obj.callId === 'string' ? obj.callId : String(obj.id)
            const name = typeof obj.name === 'string'
                ? obj.name
                : (isObject(obj.tool) && typeof obj.tool.name === 'string' ? obj.tool.name : 'tool')
            if (isHardBoundaryToolName(name)) {
                return [{ kind: 'boundary' }]
            }
            events.push({
                kind: 'tool',
                toolUseId,
                name,
                phase: 'start',
                state: 'running',
                input: obj.input ?? obj.arguments
            })
            continue
        }

        if ((type === 'tool-call-result' || type === 'tool_result' || type === 'tool-result') && (typeof obj.callId === 'string' || typeof obj.tool_use_id === 'string')) {
            const toolUseId = typeof obj.callId === 'string' ? obj.callId : String(obj.tool_use_id)
            const isError = obj.is_error === true || obj.success === false
            events.push({
                kind: 'tool',
                toolUseId,
                name: typeof obj.name === 'string' ? obj.name : 'tool',
                phase: 'result',
                state: isError ? 'error' : 'completed'
            })
        }
    }

    if (events.length > 0) {
        // Assistant text mixed with tools is a boundary for grouping purposes when visible text exists.
        if (hasVisibleText(content)) {
            return [{ kind: 'boundary' }, ...events]
        }
        return events
    }

    // Reasoning-only is transparent
    let sawReasoning = false
    for (const obj of objects) {
        const type = typeof obj.type === 'string' ? obj.type : ''
        if (type === 'reasoning' || type === 'thinking' || type === 'codex' && isObject(obj.data) && obj.data.type === 'reasoning') {
            sawReasoning = true
        }
    }
    if (sawReasoning && !hasVisibleText(content)) {
        return [{ kind: 'transparent' }]
    }

    // User / assistant visible content
    if (hasVisibleText(content)) {
        return [{ kind: 'boundary' }]
    }

    // role user without tools
    const role = isObject(content) && typeof content.role === 'string' ? content.role : null
    if (role === 'user') {
        return [{ kind: 'boundary' }]
    }

    return [{ kind: 'transparent' }]
}

function emptySummary(): ToolGroupTimelineSummary {
    return {
        totalTools: 0,
        countsByKind: { read: 0, search: 0, command: 0, mutation: 0, web: 0, other: 0 },
        fileTargets: [],
        commandTargets: [],
        searchTargets: [],
        urlTargets: [],
        otherTargets: [],
        errorCount: 0,
        runningCount: 0,
        pendingCount: 0
    }
}

function summarizeTools(tools: Array<{ id: string; name: string; state: 'pending' | 'running' | 'completed' | 'error'; input?: unknown }>): ToolGroupTimelineSummary {
    const summary = emptySummary()
    summary.totalTools = tools.length
    for (const tool of tools) {
        const kind = getToolGroupActionKindFromName(tool.name, tool.input)
        summary.countsByKind[kind] += 1
        if (tool.state === 'error') summary.errorCount += 1
        if (tool.state === 'running') summary.runningCount += 1
        if (tool.state === 'pending') summary.pendingCount += 1
    }
    return summary
}

/**
 * History projection groups:
 * - consecutive tool activity (starts/results) forms an open group
 * - hard boundaries (assistant text / plan / interactive tools) seal the open group
 * - trailing multi-tool groups seal when all tools are terminal
 *
 * Live "do not grow a displayed group" is enforced on the client via previousGroups.
 * Backend pages never cut mid-group (expandPageToCompleteToolGroups).
 */
export function buildSealedToolGroups(messages: readonly TimelineMessage[]): ToolGroupTimelineEntry[] {
    type OpenTool = {
        id: string
        name: string
        state: 'pending' | 'running' | 'completed' | 'error'
        input?: unknown
        firstSeq: number
        lastSeq: number
        firstMessageId: string
        lastMessageId: string
        createdAt: number
    }

    const groups: ToolGroupTimelineEntry[] = []
    let open: {
        id: string
        tools: Map<string, OpenTool>
        firstSeq: number
        lastSeq: number
        firstMessageId: string
        lastMessageId: string
        createdAt: number
    } | null = null

    const sealOpen = () => {
        if (!open || open.tools.size === 0) {
            open = null
            return
        }
        // Single-tool groups are still emitted as groups for stable lazy loading when compacting,
        // but compact projection may choose to keep singles inline. We only seal multi-tool here.
        const tools = [...open.tools.values()]
        if (tools.length < 2) {
            open = null
            return
        }
        const summary = summarizeTools(tools)
        groups.push({
            id: open.id,
            firstSeq: open.firstSeq,
            lastSeq: open.lastSeq,
            firstMessageId: open.firstMessageId,
            lastMessageId: open.lastMessageId,
            createdAt: open.createdAt,
            sealed: true,
            toolUseIds: tools.map((tool) => tool.id),
            summary,
            toolsPreview: tools.map((tool) => ({
                id: tool.id,
                name: tool.name,
                state: tool.state
            }))
        })
        open = null
    }

    const openHasActiveTools = (): boolean => {
        if (!open) return false
        for (const tool of open.tools.values()) {
            if (tool.state === 'running' || tool.state === 'pending') return true
        }
        return false
    }

    for (const message of messages) {
        const classified = extractToolEvents(message.content)
        for (const event of classified) {
            if (event.kind === 'boundary') {
                sealOpen()
                continue
            }
            if (event.kind === 'transparent') {
                continue
            }

            if (event.phase === 'start') {
                // Contiguous packing: continue the open group across sequential tools.
                // Live non-grow is handled client-side once a group has been displayed.
                if (!open) {
                    open = {
                        id: `tool-group:${event.toolUseId}`,
                        tools: new Map(),
                        firstSeq: message.seq,
                        lastSeq: message.seq,
                        firstMessageId: message.id,
                        lastMessageId: message.id,
                        createdAt: message.createdAt
                    }
                }
                const existing = open.tools.get(event.toolUseId)
                if (existing) {
                    existing.name = event.name || existing.name
                    existing.input = event.input ?? existing.input
                    if (existing.state === 'completed' || existing.state === 'error') {
                        // keep terminal
                    } else {
                        existing.state = event.state
                    }
                    existing.lastSeq = message.seq
                    existing.lastMessageId = message.id
                } else {
                    open.tools.set(event.toolUseId, {
                        id: event.toolUseId,
                        name: event.name,
                        state: event.state,
                        input: event.input,
                        firstSeq: message.seq,
                        lastSeq: message.seq,
                        firstMessageId: message.id,
                        lastMessageId: message.id,
                        createdAt: message.createdAt
                    })
                }
                open.lastSeq = message.seq
                open.lastMessageId = message.id
                continue
            }

            // result / update
            if (!open) {
                // orphan result — ignore for grouping
                continue
            }
            const existing = open.tools.get(event.toolUseId)
            if (existing) {
                if (event.name && event.name !== 'tool') existing.name = event.name
                existing.state = event.state
                existing.lastSeq = message.seq
                existing.lastMessageId = message.id
            }
            open.lastSeq = message.seq
            open.lastMessageId = message.id
        }
    }

    // Trailing open group: seal only if multi-tool and all terminal (history).
    // If still active, leave unsealed (not returned as sealed summary).
    if (open && open.tools.size >= 2 && !openHasActiveTools()) {
        sealOpen()
    }

    return groups
}

export function buildToolGroupSummaryMessage(group: ToolGroupTimelineEntry): TimelineMessage {
    return {
        id: `tg-summary:${group.id}`,
        seq: group.firstSeq,
        createdAt: group.createdAt,
        localId: null,
        content: {
            role: 'agent',
            content: {
                type: 'tool-group-summary',
                id: group.id,
                firstSeq: group.firstSeq,
                lastSeq: group.lastSeq,
                firstMessageId: group.firstMessageId,
                lastMessageId: group.lastMessageId,
                sealed: true,
                summary: group.summary,
                toolsPreview: group.toolsPreview
            },
            meta: {
                toolGroup: true,
                groupId: group.id
            }
        }
    }
}

/**
 * Replace sealed multi-tool spans with a single summary message.
 * Non-group messages pass through unchanged.
 */
export function compactMessagesWithToolGroupSummaries<T extends TimelineMessage>(
    messages: readonly T[]
): T[] {
    if (messages.length === 0) return []
    const groups = buildSealedToolGroups(messages)
    if (groups.length === 0) return [...messages]

    const byFirstSeq = new Map(groups.map((group) => [group.firstSeq, group]))
    const covered = new Set<number>()
    for (const group of groups) {
        for (const message of messages) {
            if (message.seq >= group.firstSeq && message.seq <= group.lastSeq) {
                covered.add(message.seq)
            }
        }
    }

    const output: T[] = []
    const emittedGroups = new Set<string>()
    for (const message of messages) {
        const group = byFirstSeq.get(message.seq)
        if (group && !emittedGroups.has(group.id)) {
            emittedGroups.add(group.id)
            output.push(buildToolGroupSummaryMessage(group) as T)
            continue
        }
        if (covered.has(message.seq)) {
            // Skip raw tool messages replaced by summary.
            // Keep the firstSeq message only via summary emission above.
            continue
        }
        output.push(message)
    }
    return output
}

export function findToolGroupCoveringSeq(
    groups: readonly ToolGroupTimelineEntry[],
    seq: number
): ToolGroupTimelineEntry | null {
    for (const group of groups) {
        if (seq >= group.firstSeq && seq <= group.lastSeq) return group
    }
    return null
}

export function isToolGroupSummaryContent(content: unknown): content is {
    role: 'agent'
    content: {
        type: 'tool-group-summary'
        id: string
        firstSeq: number
        lastSeq: number
        sealed?: boolean
        summary: ToolGroupTimelineSummary
        toolsPreview?: ToolGroupTimelineEntry['toolsPreview']
    }
} {
    if (!isObject(content)) return false
    if (content.role !== 'agent') return false
    const inner = content.content
    if (!isObject(inner)) return false
    return inner.type === 'tool-group-summary' && typeof inner.id === 'string'
}
