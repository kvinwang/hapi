import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadsWorkspace } from './ThreadsWorkspace'

const mocks = vi.hoisted(() => ({ persistent: true, threadId: 'thread-1' as string | undefined }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ baseUrl: 'workspace-test' }) }))
vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ threadId: mocks.threadId }), useSearch: () => ({ fromSession: 'source' }) }))
vi.mock('@/hooks/useWorkspaceLayout', () => ({ useWorkspaceLayout: () => ({ sessionSidebar: mocks.persistent ? 'persistent' : 'drawer' }) }))
vi.mock('@/hooks/useResizableWidth', () => ({ useResizableWidth: () => ({ width: 340, handleMouseDown: () => {}, handleTouchStart: () => {} }) }))
vi.mock('@/routes/threads', () => ({ default: ({ selectedThreadId }: { selectedThreadId: string }) => <div>List selected: {selectedThreadId}</div> }))
vi.mock('./ThreadVoiceConversation', () => ({ ThreadVoiceConversation: ({ threadId, fromSession, toggleSidebar }: { threadId: string; fromSession: string; toggleSidebar: () => void }) => <div>Conversation: {threadId}, from {fromSession}<button onClick={toggleSidebar}>Toggle list</button></div> }))
afterEach(() => { cleanup(); localStorage.clear() })
it('keeps the desktop list alongside the selected conversation', () => {
    mocks.persistent = true
    mocks.threadId = 'thread-1'
    render(<ThreadsWorkspace />)
    expect(screen.getByRole('complementary', { name: 'Thread list' })).toBeTruthy()
    expect(screen.getByText('Conversation: thread-1, from source')).toBeTruthy()
    expect(screen.getByRole('separator')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle list' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(screen.getByText('Conversation: thread-1, from source')).toBeTruthy()
})
it('uses a dismissible list drawer on mobile', () => {
    mocks.persistent = false
    mocks.threadId = 'thread-1'
    render(<ThreadsWorkspace />)
    expect(screen.queryByRole('complementary')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle list' }))
    expect(screen.getByRole('complementary')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close thread list' }))
    expect(screen.queryByRole('complementary')).toBeNull()
})
it('shows the list first on mobile without mounting a conversation', () => {
    mocks.persistent = false
    mocks.threadId = undefined
    render(<ThreadsWorkspace />)
    expect(screen.getByRole('complementary')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Thread conversation' })).toBeNull()
})
