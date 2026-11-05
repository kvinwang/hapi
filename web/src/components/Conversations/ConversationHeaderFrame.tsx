import type { ReactNode } from 'react'
import { useWorkspaceLayout } from '@/hooks/useWorkspaceLayout'
import { useSessionHeaderPosition } from '@/hooks/useSessionHeaderStyle'

export type ConversationHeaderPlacement = 'top' | 'bottom'

/** Touch layouts keep the title under the conversation unless the user chose otherwise. */
export function useConversationHeaderPlacement(): ConversationHeaderPlacement {
    const touchLayout = useWorkspaceLayout().composer === 'docked'
    const { headerPosition } = useSessionHeaderPosition()
    return headerPosition === 'bottom' || (headerPosition === 'auto' && touchLayout) ? 'bottom' : 'top'
}

export function ConversationHeaderFrame({ placement = 'top', compact, children }: {
    placement?: ConversationHeaderPlacement
    compact?: boolean
    children: ReactNode
}) {
    return (
        <div
            data-compact={compact || undefined}
            data-conversation-header={placement}
            className={placement === 'bottom'
                ? 'shrink-0 border-t border-[var(--app-border)] bg-[var(--app-bg)] pb-[env(safe-area-inset-bottom)]'
                : 'doc-sticky-top bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]'}
        >
            {children}
        </div>
    )
}
