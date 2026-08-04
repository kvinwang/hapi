import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@hapi/protocol/chat'
import type { ApiClient } from '@/api/client'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { ToolCard } from '@/components/ToolCard/ToolCard'
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
        dispatchEvent: () => false
    })
})

function pendingTool(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'read-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'read-1',
            name: 'Read',
            state: 'completed',
            input: { file_path: 'truncated' },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            resultPending: true,
            groupSpan: { firstSeq: 5, lastSeq: 6 }
        },
        children: []
    }
}

describe('ToolCard', () => {
    afterEach(cleanup)

    it('hydrates a compacted singleton when its detail dialog opens', async () => {
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
                                    content: 'complete file body'
                                }]
                            }
                        }
                    }
                }
            }]
        }))
        const api = { getToolGroupMessages } as unknown as ApiClient
        const block = pendingTool()

        render(
            <I18nProvider>
                <HappyChatProvider value={{
                    api,
                    sessionId: 'session-1',
                    metadata: { path: 'repo', host: 'local' },
                    disabled: false,
                    onRefresh: vi.fn(),
                    staticView: false,
                    trimMode: false,
                    mutatePreservingScroll: mutate => mutate()
                }}>
                    <ToolCard
                        api={api}
                        sessionId="session-1"
                        metadata={{ path: 'repo', host: 'local' }}
                        disabled={false}
                        onDone={vi.fn()}
                        block={block}
                    />
                </HappyChatProvider>
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /truncated/i }))
        await waitFor(() => {
            expect(getToolGroupMessages).toHaveBeenCalledWith('session-1', { firstSeq: 5, lastSeq: 6 })
        })
        await waitFor(() => {
            expect(within(screen.getByRole('dialog')).getAllByText('complete file body').length).toBeGreaterThan(0)
        })
    })
})
