import type { ChatBlock, ToolCallBlock } from '@hapi/protocol/chat'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getHapiSendCommand } from '@/chat/hapiSendCommand'
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
    summary: ToolGroupSummary
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock

type ToolGroupingOptions = {
    previousGroups?: ToolGroupBlock[]
}

/** Plan/report milestones: rendered as standalone cards, never folded into a group. */
const MILESTONE_TOOL_NAMES = new Set([
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning',
    'ReportFindings',
    'report_findings'
])

/**
 * Soft milestones used to stay visible as standalone cards in earlier designs.
 * They still fragment long Claude Code runs (Task / Agent between Bash bursts),
 * so they are groupable — only plan tools + interactive prompts remain hard boundaries.
 */
const INTERACTIVE_TOOL_NAMES = new Set([
    'CodexPermission'
])

function pushUnique(target: string[], seen: Set<string>, value: string | null): void {
    if (!value) return
    if (seen.has(value)) return
    seen.add(value)
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

    // Subagent / Task cards still count as tool activity when grouped.
    if (isSubagentToolName(name) || name === 'CodexAgent' || nameLooksLike(name, ['task', 'agent'])) {
        return 'other'
    }

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
    const fileTargetSet = new Set<string>()
    const commandTargetSet = new Set<string>()
    const searchTargetSet = new Set<string>()
    const urlTargetSet = new Set<string>()
    const otherTargetSet = new Set<string>()
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
            pushUnique(fileTargets, fileTargetSet, getPrimaryFileTarget(tool))
            continue
        }
        if (kind === 'search') {
            pushUnique(searchTargets, searchTargetSet, getPrimarySearchTarget(tool))
            continue
        }
        if (kind === 'command') {
            const command = normalizeCommandInput(tool.tool.input)
            pushUnique(commandTargets, commandTargetSet, command ? formatCommandSubtitle(command, 120) : null)
            continue
        }
        if (kind === 'web') {
            pushUnique(urlTargets, urlTargetSet, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(otherTargets, otherTargetSet, getPrimaryOtherTarget(tool))
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
    // Keep plan/todo/report milestones and pending interactive prompts as hard boundaries.
    // Task/Agent/Skill are groupable so long Claude/Grok runs pack into contiguous cards
    // instead of alternating tiny groups with standalone Task/Bash rows.
    if (MILESTONE_TOOL_NAMES.has(block.tool.name)) return false
    if (isInteractiveToolBlock(block)) return false
    // Cross-session messages are conversation events, not incidental shell work.
    if (getHapiSendCommand(block.tool.name, block.tool.input)) return false
    // Team messaging tools still act as structural boundaries.
    if (
        block.tool.name === 'TeamCreate'
        || block.tool.name === 'TeamDelete'
        || block.tool.name === 'SendMessage'
    ) {
        return false
    }
    return true
}

/**
 * A group is named after the tool that opens it. The hub never splits a tool run
 * across pages, so the opening tool — and therefore the id — stays the same no
 * matter how much history is loaded around it.
 */
function createToolGroupId(tools: ToolCallBlock[], usedGroupIds: Set<string>): string {
    const base = `tool-group:${tools[0]?.id ?? 'unknown'}`
    if (!usedGroupIds.has(base)) {
        usedGroupIds.add(base)
        return base
    }
    let suffix = 2
    while (usedGroupIds.has(`${base}:${suffix}`)) suffix += 1
    const id = `${base}:${suffix}`
    usedGroupIds.add(id)
    return id
}

export function isToolGroupBlock(block: VisibleChatBlock | ChatBlock): block is ToolGroupBlock {
    return block.kind === 'tool-group'
}

/**
 * Claude often inserts `agent-reasoning` (thinking) between tool_use turns.
 * Those must not split consecutive tool activity into intermittent groups.
 */
function isTransparentForToolGrouping(block: ChatBlock): boolean {
    return block.kind === 'agent-reasoning'
}

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions = {}
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const previousGroups = options.previousGroups ?? []
    const usedGroupIds = new Set<string>()

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block.kind !== 'tool-call' || !isEligibleForToolGrouping(block)) {
            visibleBlocks.push(block)
            continue
        }

        const tools: ToolCallBlock[] = [block]
        // Reasoning after the last tool in the run (before a real boundary) is re-emitted.
        let trailingTransparent: ChatBlock[] = []
        let cursor = index + 1
        while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            if (isTransparentForToolGrouping(candidate)) {
                trailingTransparent.push(candidate)
                cursor += 1
                continue
            }
            if (candidate.kind === 'tool-call' && isEligibleForToolGrouping(candidate)) {
                tools.push(candidate)
                // Thinking between tools is noise for the timeline; drop it.
                trailingTransparent = []
                cursor += 1
                continue
            }
            break
        }

        if (tools.length < 2) {
            // No group — keep original order including any transparent blocks we scanned.
            visibleBlocks.push(block)
            for (let k = index + 1; k < cursor; k += 1) {
                visibleBlocks.push(blocks[k])
            }
            index = cursor - 1
            continue
        }

        const id = createToolGroupId(tools, usedGroupIds)
        const previous = previousGroups.find((group) => group.id === id)
        if (
            previous
            && previous.tools.length === tools.length
            && previous.tools.every((tool, toolIndex) => tool === tools[toolIndex])
        ) {
            visibleBlocks.push(previous)
        } else {
            visibleBlocks.push({
                kind: 'tool-group',
                id,
                createdAt: tools[0].createdAt,
                invokedAt: null,
                firstToolId: tools[0].id,
                lastToolId: tools[tools.length - 1].id,
                tools,
                defaultOpen: false,
                summary: summarizeToolGroup(tools)
            })
        }
        // Keep reasoning that sits after the tool run (before user/assistant text).
        for (const transparent of trailingTransparent) {
            visibleBlocks.push(transparent)
        }
        index = cursor - 1
    }

    return visibleBlocks
}

/** Target/instruction from the most recent call in a collapsed group. */
export function formatLatestToolTarget(
    block: ToolGroupBlock,
    resolvePath: (path: string) => string
): string | null {
    const tool = block.tools.at(-1)
    if (!tool) return null

    const kind = getToolGroupActionKind(tool)
    if (kind === 'read' || kind === 'mutation') {
        const target = getPrimaryFileTarget(tool)
        return target ? resolvePath(target) : null
    }
    if (kind === 'command') {
        const command = normalizeCommandInput(tool.tool.input)
        return command ? formatCommandSubtitle(command, 72) : null
    }
    if (kind === 'search') return getPrimarySearchTarget(tool)
    if (kind === 'web') return getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool)
    return getPrimaryOtherTarget(tool)
}
