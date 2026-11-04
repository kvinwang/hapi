import { useEffect, useState } from 'react'
import { useParams, useSearch } from '@tanstack/react-router'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useResizableWidth } from '@/hooks/useResizableWidth'
import ThreadsPage from '@/routes/threads'
import { ThreadVoiceConversation } from './ThreadVoiceConversation'

export function ThreadsWorkspace() {
    const params = useParams({ strict: false })
    const search = useSearch({ strict: false })
    const threadId = 'threadId' in params ? params.threadId : undefined
    const fromSession = 'fromSession' in search ? search.fromSession : undefined
    const persistent = useWorkspaceLayout().sessionSidebar === 'persistent'
    const { width, handleMouseDown, handleTouchStart } = useResizableWidth({
        storageKey: 'hapi-sidebar-width',
        min: 280,
        max: 600,
        defaultWidth: 340,
        edge: 'right'
    })
    const [lastThread, setLastThread] = useState<string>()
    const [drawer, setDrawer] = useState(false)
    const [sidebar, setSidebar] = useState(true)
    useEffect(() => {
        if (threadId) setLastThread(threadId)
        setDrawer(false)
    }, [threadId])
    useEffect(() => {
        if (!drawer) return
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setDrawer(false)
        }
        window.addEventListener('keydown', escape)
        return () => window.removeEventListener('keydown', escape)
    }, [drawer])
    const selected = threadId ?? (persistent ? lastThread : undefined)
    const showList = !threadId || (persistent ? sidebar : drawer)
    const showChat = persistent || Boolean(threadId)
    const overlay = !persistent && Boolean(threadId) && drawer
    return (
        <div className="relative flex h-full min-h-0 min-w-0">
            {overlay && (
                <button
                    type="button"
                    aria-label="Close thread list"
                    className="fixed inset-0 z-40 bg-black/50"
                    onClick={() => setDrawer(false)}
                />
            )}
            {showList && (
                <aside
                    aria-label="Thread list"
                    className={`flex min-h-0 shrink-0 flex-col bg-[var(--app-bg)] ${overlay ? 'fixed inset-y-0 left-0 z-50 w-[85vw] max-w-sm shadow-2xl' : ''}`}
                    style={overlay ? undefined : { width: persistent ? width : '100%' }}
                >
                    <ThreadsPage
                        selectedThreadId={selected}
                        onSelect={() => setDrawer(false)}
                        fromSession={fromSession}
                        onClose={overlay ? () => setDrawer(false) : undefined}
                    />
                </aside>
            )}
            {persistent && showList && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    className="relative w-1 shrink-0 cursor-col-resize bg-[var(--app-divider)] hover:bg-[var(--app-link)]"
                    onMouseDown={handleMouseDown}
                    onTouchStart={handleTouchStart}
                >
                    <div className="absolute inset-y-0 -left-1 -right-1" />
                </div>
            )}
            {showChat && (
                <section aria-label="Thread conversation" className="min-h-0 min-w-0 flex-1">
                    {selected ? (
                        <ThreadVoiceConversation
                            threadId={selected}
                            fromSession={fromSession}
                            toggleSidebar={() =>
                                persistent ? setSidebar(value => !value) : setDrawer(value => !value)
                            }
                            sidebarVisible={persistent ? sidebar : drawer}
                        />
                    ) : (
                        <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--app-hint)]">
                            Select a thread to start chatting
                        </div>
                    )}
                </section>
            )}
        </div>
    )
}
