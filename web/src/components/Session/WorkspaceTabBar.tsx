import type { ReactNode } from 'react'
import type { WorkspaceTabId } from '@/components/Session/workspace-tabs'

function SessionsIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 6h13M8 12h13M8 18h13" />
            <circle cx="3" cy="6" r="1" fill="currentColor" stroke="none" />
            <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
            <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
    )
}

function ChatIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function FilesIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
    )
}

function TreeIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M2 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
        </svg>
    )
}

interface WorkspaceTabBarProps {
    activeTab: WorkspaceTabId
    onChangeTab: (tab: WorkspaceTabId) => void
    onTreeClick: () => void
    treeActive?: boolean
    onSessionsClick?: () => void
    sessionsActive?: boolean
}

export type WorkspaceButtonId = 'sessions' | 'chat' | 'files' | 'terminal' | 'tree'

function buttonClass(active: boolean): string {
    const base = 'flex h-9 w-9 items-center justify-center rounded-md transition-colors'
    if (active) {
        return `${base} bg-[var(--app-subtle-bg)] text-[var(--app-fg)]`
    }
    return `${base} text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]`
}

/** Each workspace button on its own, for layouts that arrange them (the floating panel). */
export function workspaceButtons(props: WorkspaceTabBarProps): Partial<Record<WorkspaceButtonId, ReactNode>> {
    const tab = (id: WorkspaceTabId, label: string, icon: ReactNode) => (
        <button type="button" onClick={() => props.onChangeTab(id)} className={buttonClass(props.activeTab === id)} title={label} aria-label={label}>
            {icon}
        </button>
    )
    return {
        sessions: props.onSessionsClick ? (
            <button type="button" onClick={props.onSessionsClick} className={buttonClass(props.sessionsActive ?? false)} title="Sessions" aria-label="Toggle session list">
                <SessionsIcon />
            </button>
        ) : undefined,
        chat: tab('chat', 'Chat', <ChatIcon />),
        files: tab('files', 'Files', <FilesIcon />),
        terminal: tab('terminal', 'Terminal', <TerminalIcon />),
        tree: (
            <button type="button" onClick={props.onTreeClick} className={buttonClass(props.treeActive ?? false)} title="File tree" aria-label="Toggle file tree">
                <TreeIcon />
            </button>
        )
    }
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
    const buttons = workspaceButtons(props)
    const divider = <div className="my-0.5 h-px w-7 bg-[var(--app-border)]" aria-hidden="true" />
    return (
        <>
            {buttons.sessions ? <>{buttons.sessions}{divider}</> : null}
            {buttons.chat}
            {buttons.files}
            {buttons.terminal}
            {divider}
            {buttons.tree}
        </>
    )
}
