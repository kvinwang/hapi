import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
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
        historyState: 'complete',
        needsOlderHistory: false,
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

function renderCard(block: ToolGroupBlock, options?: { loadOlder?: () => Promise<boolean>; hasMore?: boolean; isLoadingMore?: boolean }) {
    const loadOlderMessagesPreservingScroll = options?.loadOlder ?? vi.fn(async () => false)
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: {} as never,
                sessionId: 'session-1',
                metadata: { path: 'repo', host: 'local' },
                disabled: false,
                onRefresh: vi.fn(),
                staticView: false,
                trimMode: false,
                hasMoreMessages: options?.hasMore ?? false,
                isLoadingMoreMessages: options?.isLoadingMore ?? false,
                loadOlderMessagesPreservingScroll,
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
                    hasMoreMessages: false,
                    isLoadingMoreMessages: false,
                    loadOlderMessagesPreservingScroll: vi.fn(async () => false),
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

    it('auto-loads older history after expand when the group is incomplete', async () => {
        const loadOlder = vi.fn()

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return false
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                                disabled: false,
                        onRefresh: vi.fn(),
                staticView: false,
                trimMode: false,
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: false,
                        loadOlderMessagesPreservingScroll,
                        mutatePreservingScroll: (mutate) => mutate(),
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /bun test/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('only auto-hydrates once per expand (no loop while hasMore remains true)', async () => {
        let loadCount = 0

        function Harness() {
            const [isLoadingMore, setIsLoadingMore] = useState(false)
            const [hasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(() => {
                loadCount += 1
                setIsLoadingMore(true)
                return new Promise<boolean>((resolve) => {
                    setTimeout(() => {
                        setIsLoadingMore(false)
                        // Still more history — must not trigger another auto hydrate.
                        resolve(true)
                    }, 0)
                })
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                                disabled: false,
                        onRefresh: vi.fn(),
                staticView: false,
                trimMode: false,
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                        mutatePreservingScroll: (mutate) => mutate(),
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /bun test/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadCount).toBe(1)
        })
        // Give any accidental retry a chance to fire
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50))
        })
        expect(loadCount).toBe(1)
    })

    it('waits for an in-flight thread pagination to finish before retrying hydration', async () => {
        const loadOlder = vi.fn(async () => false)
        let releaseThreadLoad: (() => void) | null = null

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const [isLoadingMore, setIsLoadingMore] = useState(true)

            releaseThreadLoad = () => setIsLoadingMore(false)

            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return false
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                                disabled: false,
                        onRefresh: vi.fn(),
                staticView: false,
                trimMode: false,
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                        mutatePreservingScroll: (mutate) => mutate(),
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /bun test/i })

        fireEvent.click(groupToggle)

        expect(loadOlder).not.toHaveBeenCalled()
        expect(screen.queryByText('Earlier tool activity is unavailable.')).not.toBeInTheDocument()

        await act(async () => {
            releaseThreadLoad?.()
        })

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })
})
