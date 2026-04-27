import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { DirectoryTree } from './DirectoryTree'

function RotateIcon(props: { spinning?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.spinning ? 'animate-spin' : ''}
        >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
            <path d="M20.49 15A9 9 0 0 1 5.64 18.36L1 14" />
        </svg>
    )
}

function FolderRootIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M2 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
        </svg>
    )
}

interface FileExplorerPaneProps {
    api: ApiClient | null
    sessionId: string
    rootLabel: string
    cwd?: string
    onOpenFile: (path: string) => void
    onEnterDirectory?: (path: string) => void
    className?: string
    headerActions?: React.ReactNode
}

export function FileExplorerPane(props: FileExplorerPaneProps) {
    const queryClient = useQueryClient()

    const handleRefresh = useCallback(() => {
        // Invalidate every per-directory query for this session so each expanded node refetches.
        // Do NOT bump a remount key here — collapsing the tree on refresh is bad UX.
        void queryClient.invalidateQueries({
            predicate: (query) => {
                const key = query.queryKey
                return Array.isArray(key) && key[0] === 'session-directory' && key[1] === props.sessionId
            }
        })
    }, [queryClient, props.sessionId])

    return (
        <div
            className={`flex h-full flex-col bg-surface-0 text-foreground ${props.className ?? ''}`}
        >
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border-default bg-surface-sidebar px-3">
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                    <FolderRootIcon />
                    <span className="truncate">{props.rootLabel || 'Files'}</span>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        onClick={handleRefresh}
                        className="rounded p-1 text-foreground-muted hover:bg-surface-2 hover:text-foreground transition-colors"
                        title="Refresh"
                    >
                        <RotateIcon />
                    </button>
                    {props.headerActions}
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <DirectoryTree
                    key={props.cwd ?? props.sessionId}
                    api={props.api}
                    sessionId={props.sessionId}
                    rootLabel={props.rootLabel}
                    cwd={props.cwd}
                    onOpenFile={props.onOpenFile}
                    onEnterDirectory={props.onEnterDirectory}
                />
            </div>
        </div>
    )
}
