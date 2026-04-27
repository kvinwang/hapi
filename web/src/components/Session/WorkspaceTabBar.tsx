import type { WorkspaceTabId } from '@/components/Session/workspace-tabs'

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
}

function buttonClass(active: boolean): string {
    const base = 'flex h-9 w-9 items-center justify-center rounded-md transition-colors'
    if (active) {
        return `${base} bg-[var(--app-subtle-bg)] text-[var(--app-fg)]`
    }
    return `${base} text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]`
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
    return (
        <>
            <button
                type="button"
                onClick={() => props.onChangeTab('chat')}
                className={buttonClass(props.activeTab === 'chat')}
                title="Chat"
                aria-label="Chat"
            >
                <ChatIcon />
            </button>
            <button
                type="button"
                onClick={() => props.onChangeTab('files')}
                className={buttonClass(props.activeTab === 'files')}
                title="Files"
                aria-label="Files"
            >
                <FilesIcon />
            </button>
            <button
                type="button"
                onClick={() => props.onChangeTab('terminal')}
                className={buttonClass(props.activeTab === 'terminal')}
                title="Terminal"
                aria-label="Terminal"
            >
                <TerminalIcon />
            </button>
            <div className="my-0.5 h-px w-7 bg-[var(--app-border)]" aria-hidden="true" />
            <button
                type="button"
                onClick={props.onTreeClick}
                className={buttonClass(props.treeActive ?? false)}
                title="File tree"
                aria-label="Toggle file tree"
            >
                <TreeIcon />
            </button>
        </>
    )
}
