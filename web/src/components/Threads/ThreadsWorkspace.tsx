import { useConversationRuntime } from '@/components/Conversations/ConversationRuntime'
import { ConversationWorkspace } from '@/components/Conversations/ConversationWorkspace'
import ThreadsPage from '@/routes/threads'
import { ThreadConversation } from './ThreadConversation'

export function ThreadsWorkspace() {
    const { layout, sessionSelection } = useConversationRuntime()
    return (
        <ConversationWorkspace
            layout={layout}
            selection={sessionSelection}
            listLabel="Thread list"
            contentLabel="Thread conversation"
            closeLabel="Close thread list"
            sidebar={
                <ThreadsPage
                    selectedThreadId={layout.selectedId}
                    onSelect={layout.closeDrawer}
                    fromSession={layout.fromSession}
                    onClose={layout.drawer ? layout.closeDrawer : undefined}
                />
            }
        >
            {layout.selectedId ? (
                <ThreadConversation
                    threadId={layout.selectedId}
                    fromSession={layout.fromSession}
                    toggleSidebar={layout.toggleSidebar}
                    sidebarVisible={layout.sidebarVisible}
                />
            ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--app-hint)]">
                    Select a thread to start chatting
                </div>
            )}
        </ConversationWorkspace>
    )
}
