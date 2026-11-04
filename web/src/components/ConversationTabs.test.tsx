import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useParams } from '@tanstack/react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationTabs } from './ConversationTabs'
import { useConversationWorkspace } from '@/hooks/useConversationWorkspace'

vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ baseUrl: 'navigation-test' }) }))
vi.mock('@/hooks/useWorkspaceLayout', () => ({ useWorkspaceLayout: () => ({ sessionSidebar: 'persistent' }) }))
vi.mock('@/hooks/useResizableWidth', () => ({ useResizableWidth: () => ({ width: 340 }) }))
afterEach(() => { cleanup(); localStorage.clear() })
function Page({ kind }: { kind: 'sessions' | 'threads' }) {
    const params = useParams({ strict: false })
    const id = kind === 'sessions' ? params.sessionId : params.threadId
    const layout = useConversationWorkspace({ kind, currentId: id, isIndex: !id, baseUrl: 'navigation-test' })
    return <><ConversationTabs active={kind} /><p>{kind}: {layout.selectedId ?? 'list'}</p></>
}
function routerAt(path: string) {
    const root = createRootRoute({ component: Outlet })
    const sessionList = createRoute({ getParentRoute: () => root, path: '/sessions', component: () => <Page kind="sessions" /> })
    const session = createRoute({ getParentRoute: () => root, path: '/sessions/$sessionId', component: () => <Page kind="sessions" /> })
    const threadList = createRoute({ getParentRoute: () => root, path: '/threads', component: () => <Page kind="threads" /> })
    const thread = createRoute({ getParentRoute: () => root, path: '/threads/$threadId', component: () => <Page kind="threads" /> })
    return createRouter({ routeTree: root.addChildren([sessionList, session, threadList, thread]), history: createMemoryHistory({ initialEntries: [path] }) })
}
it('restores the open conversation when switching tabs, including after a page remount', async () => {
    const router = routerAt('/sessions/session-a')
    const view = render(<RouterProvider router={router} />)
    await screen.findByText('sessions: session-a')
    await router.navigate({ to: '/threads/$threadId', params: { threadId: 'thread-b' } })
    await screen.findByText('threads: thread-b')
    fireEvent.click(screen.getByRole('link', { name: 'Sessions' }))
    await screen.findByText('sessions: session-a')
    expect(router.state.location.pathname).toBe('/sessions/session-a')
    fireEvent.click(screen.getByRole('link', { name: 'Threads' }))
    await screen.findByText('threads: thread-b')
    expect(router.state.location.pathname).toBe('/threads/thread-b')
    view.unmount()
    render(<RouterProvider router={routerAt('/sessions')} />)
    await waitFor(() => expect(screen.getByRole('link', { name: 'Threads' })).toHaveAttribute('href', '/threads/thread-b'))
    expect(screen.getByText('sessions: session-a')).toBeTruthy()
})
