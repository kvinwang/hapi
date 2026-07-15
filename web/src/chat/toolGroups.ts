import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import {
    formatCommandSubtitle,
    getInputStringAny,
    getShellCommand,
    isShellToolCall
} from '@/lib/toolInputUtils'

export type ToolGroupActionKind = 'read' | 'search' | 'command' | 'mutation' | 'web' | 'other'

export type ToolGroupSummary = {
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

export type ToolGroupBlock = {
    kind: 'tool-group'
    id: string
    createdAt: number
    invokedAt?: number | null
    firstToolId: string
    lastToolId: string
    tools: ToolCallBlock[]
    defaultOpen: boolean
    historyState: 'complete' | 'needs-older-history'
    needsOlderHistory: boolean
    summary: ToolGroupSummary
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock

type ToolGroupingOptions = {
    hasMoreMessages: boolean
    previousGroups?: ToolGroupBlock[]
}

const PLAN_TOOL_NAMES = new Set([
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning'
])

const MILESTONE_TOOL_NAMES = new Set([
    'Task',
    'Agent',
    'CodexAgent',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'Skill',
    'spawn_agent',
    'send_input',
    'resume_agent',
    'wait_agent',
    'close_agent'
])

const INTERACTIVE_TOOL_NAMES = new Set([
    'CodexPermission'
])

function pushUnique(target: string[], value: string | null): void {
    if (!value) return
    if (target.includes(value)) return
    target.push(value)
}

function normalizeCommandInput(input: unknown): string | null {
    const fromShell = getShellCommand(input)
    if (fromShell) return fromShell

    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

function nameLooksLike(name: string, prefixes: string[]): boolean {
    const lower = name.trim().toLowerCase()
    return prefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix} `) || lower.startsWith(`${prefix}\``) || lower.startsWith(`${prefix}_`))
}

export function getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    const name = block.tool.name
    const lower = name.trim().toLowerCase()
    const input = block.tool.input

    // Grok/ACP: shell tools often titled `Execute \`cmd...\`` with { variant, command }.
    if (isShellToolCall(name, input)) return 'command'

    // Mutations before search — names like search_replace must not become "search".
    if (
        name === 'Edit'
        || name === 'MultiEdit'
        || name === 'Write'
        || name === 'NotebookEdit'
        || name === 'CodexPatch'
        || name === 'CodexDiff'
        || name === 'search_replace'
        || name === 'str_replace'
        || name === 'write_file'
        || nameLooksLike(name, ['edit', 'write', 'patch', 'delete', 'replace'])
        || (lower.includes('replace') && Boolean(getPrimaryFileTarget(block)))
    ) {
        return 'mutation'
    }
    if (
        name === 'Read'
        || name === 'NotebookRead'
        || name === 'read_file'
        || nameLooksLike(name, ['read', 'view', 'cat', 'open'])
    ) {
        return 'read'
    }
    if (
        name === 'Grep'
        || name === 'Glob'
        || name === 'LS'
        || name === 'search_file_content'
        || name === 'list_directory'
        || nameLooksLike(name, ['grep', 'glob', 'find', 'list'])
        || (nameLooksLike(name, ['search']) && !lower.includes('replace'))
    ) {
        return 'search'
    }
    if (
        name === 'Bash'
        || name === 'CodexBash'
        || name === 'shell_command'
        || name === 'run_terminal_command'
        || name === 'run_terminal_cmd'
        || nameLooksLike(name, ['bash', 'shell', 'terminal', 'execute', 'run'])
    ) {
        return 'command'
    }
    if (
        name === 'WebFetch'
        || name === 'WebSearch'
        || nameLooksLike(name, ['webfetch', 'websearch', 'web_fetch', 'web_search', 'fetch', 'browse'])
    ) {
        return 'web'
    }

    // Input-shape fallbacks when the display title is free-form (common for Grok ACP).
    if (normalizeCommandInput(input) && (lower.includes('bash') || lower.includes('shell') || lower.startsWith('execute'))) {
        return 'command'
    }
    if (getPrimarySearchTarget(block) && !getPrimaryFileTarget(block)) {
        return 'search'
    }
    if (getPrimaryUrlTarget(block)) {
        return 'web'
    }
    if (
        getPrimaryFileTarget(block)
        && getInputStringAny(input, ['old_string', 'new_string', 'oldString', 'newString', 'content', 'contents', 'edits'])
    ) {
        return 'mutation'
    }
    if (getPrimaryFileTarget(block)) {
        return 'read'
    }

    return 'other'
}

function getPrimaryFileTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path', 'target_file', 'name'])
}

function getPrimarySearchTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['pattern', 'query', 'glob', 'include'])
}

function getPrimaryUrlTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['url'])
}

function getPrimaryOtherTarget(block: ToolCallBlock): string | null {
    const fileTarget = getPrimaryFileTarget(block)
    if (fileTarget) return fileTarget

    const searchTarget = getPrimarySearchTarget(block)
    if (searchTarget) return searchTarget

    const commandTarget = normalizeCommandInput(block.tool.input)
    if (commandTarget) return formatCommandSubtitle(commandTarget, 72)

    const urlTarget = getPrimaryUrlTarget(block)
    if (urlTarget) return urlTarget

    const description = getInputStringAny(block.tool.input, ['description'])
    if (description) return description

    // Avoid dumping long Grok `Execute \`...\`` titles into the group header.
    if (isShellToolCall(block.tool.name, block.tool.input)) {
        return formatCommandSubtitle(normalizeCommandInput(block.tool.input) ?? block.tool.name, 72)
    }
    if (block.tool.name.length > 48) {
        return `${block.tool.name.slice(0, 45)}…`
    }
    return block.tool.name
}

function summarizeToolGroup(tools: ToolCallBlock[]): ToolGroupSummary {
    const countsByKind: Record<ToolGroupActionKind, number> = {
        read: 0,
        search: 0,
        command: 0,
        mutation: 0,
        web: 0,
        other: 0
    }
    const fileTargets: string[] = []
    const commandTargets: string[] = []
    const searchTargets: string[] = []
    const urlTargets: string[] = []
    const otherTargets: string[] = []
    let errorCount = 0
    let runningCount = 0
    let pendingCount = 0

    for (const tool of tools) {
        const kind = getToolGroupActionKind(tool)
        countsByKind[kind] += 1

        if (tool.tool.state === 'error') {
            errorCount += 1
        } else if (tool.tool.state === 'running') {
            runningCount += 1
        } else if (tool.tool.state === 'pending') {
            pendingCount += 1
        }

        if (kind === 'read' || kind === 'mutation') {
            pushUnique(fileTargets, getPrimaryFileTarget(tool))
            continue
        }
        if (kind === 'search') {
            pushUnique(searchTargets, getPrimarySearchTarget(tool))
            continue
        }
        if (kind === 'command') {
            const command = normalizeCommandInput(tool.tool.input)
            pushUnique(commandTargets, command ? formatCommandSubtitle(command, 120) : null)
            continue
        }
        if (kind === 'web') {
            pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(otherTargets, getPrimaryOtherTarget(tool))
    }

    return {
        totalTools: tools.length,
        countsByKind,
        fileTargets,
        commandTargets,
        searchTargets,
        urlTargets,
        otherTargets,
        errorCount,
        runningCount,
        pendingCount,
    }
}

function isInteractiveToolBlock(block: ToolCallBlock): boolean {
    return INTERACTIVE_TOOL_NAMES.has(block.tool.name)
        || block.tool.permission?.status === 'pending'
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

export function isEligibleForToolGrouping(block: ToolCallBlock): boolean {
    if (isSubagentToolName(block.tool.name)) return false
    if (PLAN_TOOL_NAMES.has(block.tool.name)) return false
    if (MILESTONE_TOOL_NAMES.has(block.tool.name)) return false
    if (isInteractiveToolBlock(block)) return false
    return true
}

function createToolGroupId(
    tools: ToolCallBlock[],
    needsOlderHistory: boolean,
    previousGroups: ToolGroupBlock[]
): string {
    const firstToolId = tools[0]?.id ?? 'unknown'
    const lastToolId = tools[tools.length - 1]?.id ?? firstToolId

    const previous = previousGroups.find((group) => group.firstToolId === firstToolId || group.lastToolId === lastToolId)
    if (previous) {
        return previous.id
    }

    return needsOlderHistory
        ? `tool-group:${lastToolId}`
        : `tool-group:${firstToolId}`
}

export function isToolGroupBlock(block: VisibleChatBlock | ChatBlock): block is ToolGroupBlock {
    return block.kind === 'tool-group'
}

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const previousGroups = options.previousGroups ?? []

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block.kind !== 'tool-call' || !isEligibleForToolGrouping(block)) {
            visibleBlocks.push(block)
            continue
        }

        const tools: ToolCallBlock[] = [block]
        let cursor = index + 1
        while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            if (candidate.kind !== 'tool-call' || !isEligibleForToolGrouping(candidate)) {
                break
            }
            tools.push(candidate)
            cursor += 1
        }

        if (tools.length < 2) {
            visibleBlocks.push(block)
            continue
        }

        const startsAtOldestVisibleBoundary = visibleBlocks.length === 0
        const needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        visibleBlocks.push({
            kind: 'tool-group',
            id: createToolGroupId(tools, needsOlderHistory, previousGroups),
            createdAt: tools[0].createdAt,
            invokedAt: null,
            firstToolId: tools[0].id,
            lastToolId: tools[tools.length - 1].id,
            tools,
            defaultOpen: false,
            historyState: needsOlderHistory ? 'needs-older-history' : 'complete',
            needsOlderHistory,
            summary: summarizeToolGroup(tools)
        })
        index = cursor - 1
    }

    return visibleBlocks
}
