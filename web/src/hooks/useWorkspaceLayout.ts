import { useMediaQuery } from '@/hooks/useMediaQuery'

export interface WorkspaceLayout {
    fileSidebar: 'drawer' | 'persistent'
    sessionSidebar: 'drawer' | 'persistent'
    /** Settings: persistent category nav beside the content, or pure drill-down. */
    settingsNav: 'drilldown' | 'persistent'
    /** Subagent sessions: a side panel beside the parent chat, or their own page. */
    subagentView: 'panel' | 'page'
    /** Chat composer: always inline, or docked in the floating panel and shown on demand (touch devices). */
    composer: 'inline' | 'docked'
}

export function resolveWorkspaceLayout(input: {
    wide: boolean
    spacious: boolean
    finePointer: boolean
}): WorkspaceLayout {
    return {
        fileSidebar: input.wide && input.finePointer ? 'persistent' : 'drawer',
        sessionSidebar: input.spacious && input.finePointer ? 'persistent' : 'drawer',
        settingsNav: input.wide ? 'persistent' : 'drilldown',
        subagentView: input.wide && input.finePointer ? 'panel' : 'page',
        composer: input.finePointer ? 'inline' : 'docked',
    }
}

/** Single source of truth for workspace panel presentation. */
export function useWorkspaceLayout(): WorkspaceLayout {
    const wide = useMediaQuery('(min-width: 1024px)')
    const spacious = useMediaQuery('(min-width: 1280px)')
    const finePointer = useMediaQuery('(pointer: fine)')
    return resolveWorkspaceLayout({ wide, spacious, finePointer })
}
