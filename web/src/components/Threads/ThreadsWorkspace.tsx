import { useParams, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useConversationWorkspace } from '@/hooks/useConversationWorkspace'
import { ConversationWorkspace } from '@/components/Conversations/ConversationWorkspace'
import ThreadsPage from '@/routes/threads'
import { ThreadVoiceConversation } from './ThreadVoiceConversation'

export function ThreadsWorkspace() {
    const params = useParams({ strict: false })
    const search = useSearch({ strict: false })
    const { baseUrl } = useAppContext()
    const threadId = 'threadId' in params ? params.threadId : undefined
    const fromSession = 'fromSession' in search ? search.fromSession : undefined
    const layout = useConversationWorkspace({
        kind: 'threads',
        currentId: threadId,
        isIndex: !threadId,
        baseUrl,
        fromSession
    })
    return (
        <ConversationWorkspace
            layout={layout}
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
                <ThreadVoiceConversation
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
