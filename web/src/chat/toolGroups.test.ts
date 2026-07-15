import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import {
    buildVisibleChatBlocks,
    getToolGroupActionKind,
    isEligibleForToolGrouping,
    isToolGroupBlock,
    MAX_TOOLS_PER_GROUP,
    shouldUseActionSummaryAsTitle,
} from '@/chat/toolGroups'

function makeToolBlock(
    id: string,
    name: string,
    input: unknown = {},
    overrides: Partial<ToolCallBlock> = {}
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
        ...overrides,
    }
}

function makeTextBlock(id: string, text = 'note'): ChatBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

describe('getToolGroupActionKind', () => {
    it('classifies common execution tools', () => {
        expect(getToolGroupActionKind(makeToolBlock('read-1', 'Read'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('grep-1', 'Grep'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('bash-1', 'Bash'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('edit-1', 'Edit'))).toBe('mutation')
    })

    it('classifies Grok Execute-style shell tools as command', () => {
        const executeTitle = 'Execute `cd /tmp && bun test`'
        expect(getToolGroupActionKind(makeToolBlock('g1', executeTitle, {
            variant: 'Bash',
            command: 'cd /tmp && bun test',
        }))).toBe('command')

        expect(getToolGroupActionKind(makeToolBlock('g2', 'run_terminal_command', {
            command: 'ls -la',
        }))).toBe('command')
    })

    it('classifies search_replace as mutation not search', () => {
        expect(getToolGroupActionKind(makeToolBlock('sr-1', 'search_replace', {
            file_path: 'src/a.ts',
            old_string: 'a',
            new_string: 'b',
        }))).toBe('mutation')
    })
})

describe('Grok tool group titles', () => {
    it('uses shell command text as primary group title, not Execute display name', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('e1', 'Execute `echo one`', { variant: 'Bash', command: 'echo one' }),
            makeToolBlock('e2', 'Execute `echo two`', { variant: 'Bash', command: 'echo two' }),
            makeToolBlock('e3', 'Execute `bun test`', { variant: 'Bash', command: 'bun test' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected tool group')

        expect(visible[0].summary.countsByKind.command).toBe(3)
        expect(visible[0].summary.commandTargets[0]).toBe('echo one')
        expect(visible[0].summary.commandTargets.join(' ')).not.toMatch(/Execute/)
        // otherTargets should not hold raw Execute titles when classified as command
        expect(visible[0].summary.otherTargets).toEqual([])
    })

    it('collapses multi-line shell commands in group command targets', () => {
        const multi = "cat <<'EOF'\nline1\nline2\nEOF"
        const visible = buildVisibleChatBlocks([
            makeToolBlock('e1', `Execute \`${multi.slice(0, 20)}...\``, {
                variant: 'Bash',
                command: multi,
            }),
            makeToolBlock('e2', 'Execute `ls`', { variant: 'Bash', command: 'ls' }),
        ], { hasMoreMessages: false })

        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected tool group')
        expect(visible[0].summary.commandTargets[0]).toContain('…(+')
        expect(visible[0].summary.commandTargets[0]).not.toMatch(/Execute/)
    })
})

describe('isEligibleForToolGrouping', () => {
    it('includes Task/Agent so consecutive runs pack into one group', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('read-1', 'Read'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('task-1', 'Task'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('agent-1', 'Agent'))).toBe(true)
    })

    it('excludes interactive and plan cards as hard boundaries', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('plan-1', 'update_plan'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('ask-1', 'AskUserQuestion'))).toBe(false)
        expect(isEligibleForToolGrouping(makeToolBlock('perm-1', 'Bash', {}, {
            tool: {
                id: 'perm-1',
                name: 'Bash',
                state: 'pending',
                input: {},
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                description: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending'
                }
            }
        }))).toBe(false)
    })

    it('keeps completed permissioned execution cards eligible for grouping', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('approved-1', 'Bash', {}, {
            tool: {
                id: 'approved-1',
                name: 'Bash',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                permission: {
                    id: 'approved-1',
                    status: 'approved'
                }
            }
        }))).toBe(true)

        expect(isEligibleForToolGrouping(makeToolBlock('denied-1', 'Edit', {}, {
            tool: {
                id: 'denied-1',
                name: 'Edit',
                state: 'error',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                permission: {
                    id: 'denied-1',
                    status: 'denied',
                    reason: 'blocked'
                }
            }
        }))).toBe(true)
    })

    it('keeps Codex permission milestones standalone after completion', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('codex-perm-1', 'CodexPermission', {}, {
            tool: {
                id: 'codex-perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                permission: {
                    id: 'codex-perm-1',
                    status: 'approved'
                }
            }
        }))).toBe(false)
    })
})

describe('buildVisibleChatBlocks', () => {
    it('groups contiguous eligible root tool cards', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected tool group')
        }
        expect(visible[0].tools.map((tool) => tool.id)).toEqual(['read-1', 'bash-1', 'edit-1'])
        expect(visible[0].defaultOpen).toBe(false)
        expect(visible[0].summary.fileTargets).toEqual(['src/a.ts'])
        expect(visible[0].summary.commandTargets).toEqual(['bun test'])
    })

    it('splits groups on assistant text boundaries', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1', 'located the issue'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('keeps single eligible tool cards standalone', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(visible.every((block) => !isToolGroupBlock(block))).toBe(true)
    })

    it('keeps interactive cards standalone and uses them as hard boundaries', () => {
        const interactive = makeToolBlock('ask-1', 'request_user_input')
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            interactive,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(interactive)
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('keeps completed Codex permission cards as standalone grouping boundaries', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: 'Approved',
                permission: {
                    id: 'perm-1',
                    status: 'approved',
                    decision: 'approved'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            permission,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(permission)
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('marks only the oldest visible grouped run as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        expect(isToolGroupBlock(visible[0]) && visible[0].needsOlderHistory).toBe(true)
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after leading non-tool blocks as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeTextBlock('text-1', 'prepended assistant note'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-2', 'next section'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        expect(visible[0].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
        expect(isToolGroupBlock(visible[3]) && visible[3].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a leading standalone tool as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('single-1', 'Read', { file_path: 'src/solo.ts' }),
            makeTextBlock('text-1', 'boundary'),
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        expect(visible[0].kind).toBe('tool-call')
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a standalone permission boundary as needing older history', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: 'Approved',
                permission: {
                    id: 'perm-1',
                    status: 'approved'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            permission,
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        expect(visible[0]).toBe(permission)
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
    })

    it('reuses a previous group id when the first tool changes after prepend', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        const next = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('read-2', 'Read', { file_path: 'src/b.ts' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })

    it('reuses a previous group id when the last tool changes after append', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: false })

        const next = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })
})


describe('group packing + size cap', () => {
    it('packs Task between Bash into one contiguous group', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('b1', 'Bash', { command: 'ls' }),
            makeToolBlock('t1', 'Task', { prompt: 'investigate' }),
            makeToolBlock('b2', 'Bash', { command: 'pwd' }),
            makeToolBlock('t2', 'Task', { prompt: 'more' }),
            makeToolBlock('r1', 'Read', { file_path: 'a.ts' }),
            makeToolBlock('r2', 'Read', { file_path: 'b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected group')
        expect(visible[0].tools.map((t) => t.tool.name)).toEqual([
            'Bash', 'Task', 'Bash', 'Task', 'Read', 'Read'
        ])
    })

    it('chunks oversized runs so the page is not one mega-card', () => {
        const tools = Array.from({ length: MAX_TOOLS_PER_GROUP + 5 }, (_, i) =>
            makeToolBlock(`t-${i}`, 'Bash', { command: `echo ${i}` })
        )
        const visible = buildVisibleChatBlocks(tools, { hasMoreMessages: false })
        const groups = visible.filter(isToolGroupBlock)
        expect(groups.length).toBeGreaterThan(1)
        expect(groups.every((g) => g.tools.length <= MAX_TOOLS_PER_GROUP)).toBe(true)
        expect(groups.reduce((n, g) => n + g.tools.length, 0) + visible.filter((b) => !isToolGroupBlock(b)).length)
            .toBe(tools.length)
    })

    it('does not mark needsOlderHistory once a run already hits the size cap', () => {
        const tools = Array.from({ length: MAX_TOOLS_PER_GROUP + 2 }, (_, i) =>
            makeToolBlock(`t-${i}`, 'Read', { file_path: `f${i}.ts` })
        )
        const visible = buildVisibleChatBlocks(tools, { hasMoreMessages: true })
        const groups = visible.filter(isToolGroupBlock)
        expect(groups[0]?.needsOlderHistory).toBe(false)
    })
})

describe('shouldUseActionSummaryAsTitle', () => {
    it('prefers action summary for large multi-command groups', () => {
        const visible = buildVisibleChatBlocks(
            Array.from({ length: 10 }, (_, i) =>
                makeToolBlock(`c-${i}`, 'Bash', { command: `echo ${i}` })
            ),
            { hasMoreMessages: false }
        )
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) throw new Error('expected group')
        expect(shouldUseActionSummaryAsTitle(visible[0].summary)).toBe(true)
    })
})
