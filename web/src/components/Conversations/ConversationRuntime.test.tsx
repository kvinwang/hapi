import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ConversationRuntime } from './ConversationRuntime'

const mocks = vi.hoisted(() => ({
    pathname: '/sessions/s1',
    mounts: 0,
    targets: [] as Array<{ sessionId: string; threadId?: string }>
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { threadRequest: async () => ({ messages: [], hasMore: false }) }, baseUrl: 'hub', token: 't', guest: { sessionId: 'hidden' } }) }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [] }) }))
vi.mock('@/hooks/useWorkspaceLayout', () => ({ useWorkspaceLayout: () => ({ sessionSidebar: 'drawer' }) }))
vi.mock('@/hooks/useResizableWidth', () => ({ useResizableWidth: () => ({}) }))
vi.mock('@tanstack/react-router', () => ({
    Outlet: () => null,
    useNavigate: () => vi.fn(),
    useSearch: () => ({}),
    useLocation: ({ select }: { select: (location: { pathname: string }) => string }) => select({ pathname: mocks.pathname }),
    useMatchRoute: () => ({ to }: { to: string }) => {
        const thread = /^\/threads\/([^/]+)/.exec(mocks.pathname)
        const session = /^\/sessions\/([^/]+)/.exec(mocks.pathname)
        if (to === '/threads/$threadId') return thread ? { threadId: thread[1] } : false
        return session ? { sessionId: session[1] } : false
    }
}))
vi.mock('@/hooks/useVoiceWorkspace', async () => {
    const { useState } = await import('react')
    return {
        useVoiceWorkspace: (options: { sessionId: string; threadId?: string }) => {
            useState(() => { mocks.mounts += 1 })
            mocks.targets.push({ sessionId: options.sessionId, threadId: options.threadId })
            return { voice: { micOn: true }, readback: { enabled: false } }
        }
    }
})
afterEach(cleanup)

it('retargets one voice assistant across session, thread list and thread routes', () => {
    const client = new QueryClient()
    const tree = () => <QueryClientProvider client={client}><I18nProvider><ConversationRuntime /></I18nProvider></QueryClientProvider>
    const view = render(tree())
    for (const pathname of ['/threads', '/threads/t1', '/sessions/s2']) {
        mocks.pathname = pathname
        view.rerender(tree())
    }
    expect(mocks.mounts).toBe(1)
    expect(mocks.targets.at(0)).toEqual({ sessionId: 's1', threadId: undefined })
    expect(mocks.targets).toContainEqual({ sessionId: 'thread:t1', threadId: 't1' })
    expect(mocks.targets).not.toContainEqual(expect.objectContaining({ sessionId: '' }))
    expect(mocks.targets.at(-1)).toEqual({ sessionId: 's2', threadId: undefined })
    client.clear()
})
