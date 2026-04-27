import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { FileIcon } from '@/components/FileIcon'
import { useSessionDirectory } from '@/hooks/queries/useSessionDirectory'

// Persist tree expansion + selection per (sessionId, cwd) at module scope.
// Survives unmount/remount of the tree (drawer close/open, tab switch),
// resets on full page reload.
const expandedCache = new Map<string, Set<string>>()
const selectedCache = new Map<string, string | null>()

function cacheKey(sessionId: string, cwd: string | undefined): string {
    return `${sessionId}::${cwd ?? ''}`
}

const INDENT_PER_LEVEL = 16
const ROW_PADDING_LEFT_BASE = 8

function rowIndent(depth: number) {
    return ROW_PADDING_LEFT_BASE + depth * INDENT_PER_LEVEL
}

function ChevronIcon(props: { collapsed: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform duration-150 ${props.collapsed ? '' : 'rotate-90'}`}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function FolderIcon(props: { open: boolean }) {
    if (props.open) {
        return (
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
            >
                <path d="M2 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H4l-2 9V6z" opacity="0.85" />
                <path d="M4 9h18l-2 9a2 2 0 0 1-2 1.6H4a2 2 0 0 1-2-2V9z" opacity="0.55" />
            </svg>
        )
    }
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M2 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" opacity="0.85" />
        </svg>
    )
}

function EnterIcon() {
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
        >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <polyline points="10 17 15 12 10 7" />
            <line x1="15" y1="12" x2="3" y2="12" />
        </svg>
    )
}

function DirectorySkeleton(props: { depth: number; rows?: number }) {
    const rows = props.rows ?? 3
    const indent = rowIndent(props.depth)

    return (
        <div className="animate-pulse">
            {Array.from({ length: rows }).map((_, index) => (
                <div
                    key={`dir-skel-${props.depth}-${index}`}
                    className="flex items-center gap-2 py-1"
                    style={{ paddingLeft: indent }}
                >
                    <div className="h-3.5 w-3.5 rounded bg-surface-3" />
                    <div className="h-2.5 w-32 rounded bg-surface-3" />
                </div>
            ))}
        </div>
    )
}

function DirectoryErrorRow(props: { depth: number; message: string }) {
    const indent = rowIndent(props.depth)
    return (
        <div
            className="px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400"
            style={{ paddingLeft: indent }}
        >
            {props.message}
        </div>
    )
}

function DirectoryNode(props: {
    api: ApiClient | null
    sessionId: string
    path: string
    label: string
    depth: number
    cwd?: string
    selectedPath: string | null
    onOpenFile: (path: string) => void
    onSelect: (path: string) => void
    onEnterDirectory?: (path: string) => void
    expanded: Set<string>
    onToggle: (path: string) => void
}) {
    const isExpanded = props.expanded.has(props.path)
    const isSelected = props.selectedPath === props.path
    const { entries, error, isLoading } = useSessionDirectory(props.api, props.sessionId, props.path, {
        enabled: isExpanded,
        cwd: props.cwd
    })

    const directories = useMemo(() => entries.filter((entry) => entry.type === 'directory'), [entries])
    const files = useMemo(() => entries.filter((entry) => entry.type === 'file'), [entries])
    const childDepth = props.depth + 1

    const indent = rowIndent(props.depth)
    const childIndent = rowIndent(childDepth)

    const rowBgClass = isSelected
        ? 'bg-accent/15 hover:bg-accent/20'
        : 'hover:bg-surface-2'

    return (
        <div>
            <div
                className={`group flex w-full items-center gap-1.5 py-1 text-[13px] leading-5 ${rowBgClass} transition-colors`}
                style={{ paddingLeft: indent, paddingRight: 8 }}
            >
                <button
                    type="button"
                    onClick={() => {
                        props.onToggle(props.path)
                        props.onSelect(props.path)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground-muted">
                        <ChevronIcon collapsed={!isExpanded} />
                    </span>
                    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-accent-bright">
                        <FolderIcon open={isExpanded} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{props.label}</span>
                </button>
                {props.onEnterDirectory ? (
                    <button
                        type="button"
                        onClick={() => props.onEnterDirectory!(props.path)}
                        className="shrink-0 rounded p-1 text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
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
                                    selectedPath={props.selectedPath}
                                    onOpenFile={props.onOpenFile}
                                    onSelect={props.onSelect}
                                    onEnterDirectory={props.onEnterDirectory}
                                    expanded={props.expanded}
                                    onToggle={props.onToggle}
                                />
                            )
                        })}

                        {files.map((entry) => {
                            const filePath = props.path ? `${props.path}/${entry.name}` : entry.name
                            const isFileSelected = props.selectedPath === filePath
                            return (
                                <button
                                    key={filePath}
                                    type="button"
                                    onClick={() => {
                                        props.onSelect(filePath)
                                        props.onOpenFile(filePath)
                                    }}
                                    className={`flex w-full items-center gap-1.5 py-1 text-left text-[13px] leading-5 transition-colors ${isFileSelected ? 'bg-accent/15 hover:bg-accent/20' : 'hover:bg-surface-2'}`}
                                    style={{ paddingLeft: childIndent, paddingRight: 8 }}
                                >
                                    <span className="h-4 w-4 shrink-0" />
                                    <FileIcon fileName={entry.name} size={18} />
                                    <span className="min-w-0 flex-1 truncate text-foreground">{entry.name}</span>
                                </button>
                            )
                        })}

                        {directories.length === 0 && files.length === 0 ? (
                            <div
                                className="py-1 text-xs italic text-foreground-muted"
                                style={{ paddingLeft: childIndent }}
                            >
                                Empty
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
    selectedPath?: string | null
    onSelect?: (path: string) => void
}) {
    const stateKey = cacheKey(props.sessionId, props.cwd)

    const [expanded, setExpanded] = useState<Set<string>>(
        () => new Set(expandedCache.get(stateKey) ?? new Set(['']))
    )
    const [internalSelected, setInternalSelected] = useState<string | null>(
        () => selectedCache.get(stateKey) ?? null
    )
    const selectedPath = props.selectedPath ?? internalSelected

    useEffect(() => {
        expandedCache.set(stateKey, new Set(expanded))
    }, [stateKey, expanded])

    useEffect(() => {
        selectedCache.set(stateKey, internalSelected)
    }, [stateKey, internalSelected])

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

    const handleSelect = useCallback(
        (path: string) => {
            if (props.onSelect) {
                props.onSelect(path)
            } else {
                setInternalSelected(path)
            }
        },
        [props]
    )

    return (
        <div className="bg-surface-0 py-1">
            <DirectoryNode
                api={props.api}
                sessionId={props.sessionId}
                path=""
                label={props.rootLabel}
                depth={0}
                cwd={props.cwd}
                selectedPath={selectedPath}
                onOpenFile={props.onOpenFile}
                onSelect={handleSelect}
                onEnterDirectory={props.onEnterDirectory}
                expanded={expanded}
                onToggle={handleToggle}
            />
        </div>
    )
}
