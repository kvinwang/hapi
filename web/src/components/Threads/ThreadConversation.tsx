import { ConversationFrame } from '@/components/Conversations/ConversationFrame'
import { ThreadChat } from './ThreadChat'

export function ThreadConversation({ threadId, fromSession, toggleSidebar, sidebarVisible }: {
    threadId: string
    fromSession?: string
    toggleSidebar: () => void
    sidebarVisible: boolean
}) {
    return (
        <ConversationFrame capabilities={{
            voice: true,
            readback: true,
            composer: true,
            documentScroll: true,
            list: { title: 'Thread list', label: 'Thread list', active: sidebarVisible, onToggle: toggleSidebar }
        }}>
            <div className="doc-flow min-h-0 min-w-0 flex-1">
                <ThreadChat key={threadId} threadId={threadId} fromSession={fromSession} />
            </div>
        </ConversationFrame>
    )
}
