import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@hapi/protocol/chat'
import type { ApiClient } from '@/api/client'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import { I18nProvider } from '@/lib/i18n-context'

Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    }),
})

function makeToolBlock(id: string, name: string, input: unknown = {}): ToolCallBlock {
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
            result: { content: 'done' },
            permission: undefined,
        },
        children: [],
    }
}

function makeGroup(overrides: Partial<ToolGroupBlock> = {}): ToolGroupBlock {
    const tools = overrides.tools ?? [
        makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
        makeToolBlock('bash-1', 'Bash', { command: 'bun test' })
    ]
    return {
        kind: 'tool-group',
        id: 'tool-group:read-1',
        createdAt: 1,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        defaultOpen: false,
        summary: {
            totalTools: tools.length,
            countsByKind: {
                read: 1,
                search: 0,
                command: 1,
                mutation: 0,
                web: 0,
                other: 0,
            },
            fileTargets: ['repo/src/a.ts'],
            commandTargets: ['bun test'],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0,
        },
        ...overrides,
    }
}

function renderCard(block: ToolGroupBlock, options?: { api?: Partial<ApiClient> }) {
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: (options?.api ?? {}) as ApiClient,
                sessionId: 'session-1',
                metadata: { path: 'repo', host: 'local' },
                disabled: false,
                onRefresh: vi.fn(),
                staticView: false,
                trimMode: false,
                mutatePreservingScroll: (mutate) => mutate(),
            }}>
                <ToolGroupCard block={block} metadata={{ path: 'repo', host: 'local' }} />
            </HappyChatProvider>
        </I18nProvider>
    )
}

describe('ToolGroupCard', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders a collapsed target-first header', () => {
        renderCard(makeGroup())

        expect(screen.getByRole('button', { name: /bun test/i })).toBeInTheDocument()
        expect(screen.getByText('Read 1 · Run 1')).toBeInTheDocument()
        expect(screen.queryByText('2 tool calls')).not.toBeInTheDocument()
    })

    it('shows the last command instead of the first command when collapsed', () => {
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'echo first' }),
            makeToolBlock('bash-2', 'Bash', { command: 'echo latest' })
        ]
        renderCard(makeGroup({
            tools,
            summary: {
                ...makeGroup().summary,
                countsByKind: { ...makeGroup().summary.countsByKind, read: 0, command: 2 },
                fileTargets: [],
                commandTargets: ['echo first', 'echo latest']
            }
        }))

        expect(screen.getByRole('button', { name: /echo latest/i })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /echo first/i })).not.toBeInTheDocument()
    })

    it('mounts large tool groups in bounded pages', () => {
        const tools = Array.from({ length: 65 }, (_, index) => (
            makeToolBlock(`bash-${index + 1}`, 'Bash', { command: `echo ${index + 1}` })
        ))
        renderCard(makeGroup({ tools }))

        fireEvent.click(screen.getByRole('button', { name: /echo 65/i }))
        expect(screen.getByText('echo 30')).toBeInTheDocument()
        expect(screen.queryByText('echo 31')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Show 30 more' }))
        expect(screen.getByText('echo 60')).toBeInTheDocument()
        expect(screen.queryByText('echo 61')).not.toBeInTheDocument()
    })

    it('expands to show compact rows and opens a detail dialog per row', async () => {
        const view = renderCard(makeGroup())
        const groupToggle = within(view.container).getByRole('button', { name: /bun test/i })

        fireEvent.click(groupToggle)
        expect(screen.getByText('2 tool calls')).toBeInTheDocument()

        const firstRowButton = within(view.container)
            .getAllByRole('button')
            .find((button) => button !== groupToggle)

        expect(firstRowButton).toBeDefined()
        fireEvent.click(firstRowButton!)

        await waitFor(() => {
            expect(screen.getByRole('dialog')).toBeInTheDocument()
        })
        const dialog = screen.getByRole('dialog')
        expect(screen.getAllByText('src/a.ts')[0]).toBeInTheDocument()
        expect(within(dialog).getAllByText('Input').length).toBeGreaterThan(0)
        expect(within(dialog).getAllByText('Result').length).toBeGreaterThan(0)
    })

    it('fetches the result body on demand for a hub-compacted tool', async () => {
        const getToolGroupMessages = vi.fn(async () => ({
            messages: [{
                id: 'm2',
                seq: 6,
                localId: null,
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            message: {
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'read-1',
                                    content: 'fetched file body'
                                }]
                            }
                        }
                    }
                }
            }]
        }))

        const tools = [
            makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' })
        ]
        for (const tool of tools) {
            tool.tool.result = undefined
            tool.tool.resultPending = true
            tool.tool.groupSpan = { firstSeq: 5, lastSeq: 6 }
        }

        const view = renderCard(makeGroup({ tools }), { api: { getToolGroupMessages } })
        fireEvent.click(within(view.container).getByRole('button', { name: /bun test/i }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        const rowButton = within(view.container)
            .getAllByRole('button')
            .find((button) => button.textContent?.includes('a.ts'))
        fireEvent.click(rowButton!)

        await waitFor(() => {
            expect(getToolGroupMessages).toHaveBeenCalledWith('session-1', { firstSeq: 5, lastSeq: 6 })
        })
        await waitFor(() => {
            expect(within(screen.getByRole('dialog')).getAllByText('Result').length).toBeGreaterThan(0)
        })
    })

    it('fetches once even when the opened tool has no stored result', async () => {
        // The run's messages hold no result for this tool, so "is it in the map"
        // would stay false forever and the effect would refetch on every render.
        const getToolGroupMessages = vi.fn(async () => ({ messages: [] }))

        const tools = [
            makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' })
        ]
        for (const tool of tools) {
            tool.tool.result = undefined
            tool.tool.resultPending = true
            tool.tool.groupSpan = { firstSeq: 5, lastSeq: 6 }
        }

        const view = renderCard(makeGroup({ tools }), { api: { getToolGroupMessages } })
        fireEvent.click(within(view.container).getByRole('button', { name: /bun test/i }))
        const rowButton = within(view.container)
            .getAllByRole('button')
            .find((button) => button.textContent?.includes('a.ts'))
        fireEvent.click(rowButton!)

        await waitFor(() => {
            expect(getToolGroupMessages).toHaveBeenCalledTimes(1)
        })
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(getToolGroupMessages).toHaveBeenCalledTimes(1)
    })

    it('keeps a group expanded across streaming block updates', () => {
        const view = renderCard(makeGroup())
        const groupToggle = within(view.container).getByRole('button', { name: /bun test/i })

        fireEvent.click(groupToggle)
        expect(screen.getByText('2 tool calls')).toBeInTheDocument()

        view.rerender(
            <I18nProvider>
                <HappyChatProvider value={{
                    api: {} as never,
                    sessionId: 'session-1',
                    metadata: { path: 'repo', host: 'local' },
                    disabled: false,
                    onRefresh: vi.fn(),
                    staticView: false,
                    trimMode: false,
                    mutatePreservingScroll: (mutate) => mutate(),
                }}>
                    <ToolGroupCard
                        block={makeGroup({ defaultOpen: false, summary: { ...makeGroup().summary, runningCount: 1 } })}
                        metadata={{ path: 'repo', host: 'local' }}
                    />
                </HappyChatProvider>
            </I18nProvider>
        )

        expect(screen.getByText('2 tool calls')).toBeInTheDocument()
    })

})
