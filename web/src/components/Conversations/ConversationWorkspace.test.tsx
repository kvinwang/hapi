import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useConversationWorkspace } from '@/hooks/useConversationWorkspace'
import { ConversationWorkspace } from './ConversationWorkspace'

const state = vi.hoisted(() => ({ persistent: false }))
vi.mock('@/hooks/useWorkspaceLayout', () => ({ useWorkspaceLayout: () => ({ sessionSidebar: state.persistent ? 'persistent' : 'drawer' }) }))
vi.mock('@/hooks/useResizableWidth', () => ({ useResizableWidth: () => ({ width: 340, handleMouseDown: vi.fn(), handleTouchStart: vi.fn() }) }))
afterEach(() => { cleanup(); localStorage.clear() })

function Workspace({ picking, cancel }: { picking: boolean; cancel: () => void }) {
    const layout = useConversationWorkspace({ kind: 'sessions', currentId: 'current', isIndex: false })
    return <ConversationWorkspace layout={layout} sidebar={<div>Original list</div>} listLabel="Sessions" contentLabel="Conversation" closeLabel="Close list"
        selection={picking ? { sidebar: <div>Native numbered list</div>, label: 'Session selection', onCancel: cancel } : undefined}>
        <div>Current conversation</div>
    </ConversationWorkspace>
}

it.each([false, true])('reuses the responsive sidebar for selection (persistent=%s) without a separate dialog', persistent => {
    state.persistent = persistent
    localStorage.setItem('hapi-sidebar-visible', '0')
    const cancel = vi.fn()
    const { container, rerender } = render(<Workspace picking cancel={cancel} />)
    expect(screen.getByRole('complementary', { name: 'Session selection' })).toBeVisible()
    expect(screen.getByText('Current conversation')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(Boolean(container.querySelector('.hapi-session-drawer'))).toBe(!persistent)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledOnce()
    rerender(<Workspace picking={false} cancel={cancel} />)
    expect(screen.getByText('Original list')).not.toBeVisible()
    expect(localStorage.getItem('hapi-sidebar-visible')).toBe('0')
})
