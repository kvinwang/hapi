import { useCallback, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'

function ChevronIcon(props: { className?: string; collapsed: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    )
}

function DirectorySkeleton(props: { depth: number; rows?: number }) {
    const rows = props.rows ?? 4
    const indent = 12 + props.depth * 14

    return (
        <div className="animate-pulse">
            {Array.from({ length: rows }).map((_, index) => (
                <div
                    key={`dir-skel-${props.depth}-${index}`}
                    className="flex items-center gap-3 px-3 py-2"
                    style={{ paddingLeft: indent }}
                >
                    <div className="h-5 w-5 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="h-3 w-40 rounded bg-[var(--app-subtle-bg)]" />
                </div>
            ))}
        </div>
    )
}

function DirectoryErrorRow(props: { depth: number; message: string }) {
    const indent = 12 + props.depth * 14
    return (
        <div
            className="px-3 py-2 text-xs text-[var(--app-hint)] bg-amber-500/10"
            style={{ paddingLeft: indent }}
        >
            {props.message}
        </div>
    )
}

function EnterIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
        </svg>
    )
}

function DirectoryNode(props: {
    api: ApiClient | null
    sessionId: string
    path: string
    label: string
    depth: number
    cwd?: string
    onOpenFile: (path: string) => void
    onEnterDirectory?: (path: string) => void
    expanded: Set<string>
    onToggle: (path: string) => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const { entries, error, isLoading } = useSessionDirectory(props.api, props.sessionId, props.path, {
        enabled: isExpanded,
        cwd: props.cwd
    })

    const directories = useMemo(() => entries.filter((entry) => entry.type === 'directory'), [entries])
    const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries])
    const childDepth = props.depth + 1

    const indent = 12 + props.depth * 14
    const childIndent = 12 + childDepth * 14

    return (
        <div>
            <div
                className="flex w-full items-center gap-3 px-3 py-2 hover:bg-[var(--app-subtle-bg)] transition-colors"
                style={{ paddingLeft: indent }}
            >
                <button
                    type="button"
                    onClick={() => props.onToggle(props.path)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                    <ChevronIcon collapsed={!isExpanded} className="text-[var(--app-hint)]" />
                    <FolderIcon className="text-[var(--app-link)]" />
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{props.label}</div>
                    </div>
                </button>
                {props.onEnterDirectory ? (
                    <button
                        type="button"
                        onClick={() => props.onEnterDirectory!(props.path)}
                        className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:text-[var(--app-link)] transition-colors"
                        title="Enter directory"
                    >
                        <EnterIcon />
                    </button>
                ) : null}
            </div>

            {isExpanded ? (
                isLoading ? (
                    <DirectorySkeleton depth={childDepth} />
                ) : error ? (
                    <DirectoryErrorRow depth={childDepth} message={error} />
                ) : (
                    <div>
                        {directories.map((entry) => {
                            const childPath = props.path ? `${props.path}/${entry.name}` : entry.name
                            return (
                                <DirectoryNode
                                    key={childPath}
                                    api={props.api}
                                    sessionId={props.sessionId}
                                    path={childPath}
                                    label={entry.name}
                                    depth={childDepth}
                                    cwd={props.cwd}
                                    onOpenFile={props.onOpenFile}
                                    onEnterDirectory={props.onEnterDirectory}
                                    expanded={props.expanded}
                                    onToggle={props.onToggle}
                                />
                            )
                        })}

                        {files.map((entry) => {
                            const filePath = props.path ? `${props.path}/${entry.name}` : entry.name
                            return (
                                <button
                                    key={filePath}
                                    type="button"
                                    onClick={() => props.onOpenFile(filePath)}
                                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors"
                                    style={{ paddingLeft: childIndent }}
                                >
                                    <span className="h-4 w-4" />
                                    <FileIcon fileName={entry.name} size={22} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium">{entry.name}</div>
                                    </div>
                                </button>
                            )
                        })}

                        {directories.length === 0 && files.length === 0 ? (
                            <div
                                className="px-3 py-2 text-sm text-[var(--app-hint)]"
                                style={{ paddingLeft: childIndent }}
                            >
                                Empty directory.
                            </div>
                        ) : null}
                    </div>
                )
            ) : null}
        </div>
    )
}

export function DirectoryTree(props: {
    api: ApiClient | null
    sessionId: string
    rootLabel: string
    cwd?: string
    onOpenFile: (path: string) => void
    onEnterDirectory?: (path: string) => void
}) {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))

    const handleToggle = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(path)) {
                next.delete(path)
            } else {
                next.add(path)
            }
            return next
        })
    }, [])

    return (
        <div className="border-t border-[var(--app-divider)]">
            <DirectoryNode
                api={props.api}
                sessionId={props.sessionId}
                path=""
                label={props.rootLabel}
                depth={0}
                cwd={props.cwd}
                onOpenFile={props.onOpenFile}
                onEnterDirectory={props.onEnterDirectory}
                expanded={expanded}
                onToggle={handleToggle}
            />
        </div>
    )
}
