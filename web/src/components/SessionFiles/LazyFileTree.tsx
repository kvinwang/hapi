import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { TreeEntry } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'

type CacheEntry = { entries: TreeEntry[] } | { error: string }

export type LazyTreeState = {
    childrenCache: Map<string, CacheEntry>
    expandedPaths: Set<string>
}

// Module-level cache for tree state per session (LRU with max 10 sessions)
const MAX_CACHED_SESSIONS = 10
const treeStateCache = new Map<string, LazyTreeState>()

export function getOrCreateLazyTreeState(sessionId: string): LazyTreeState {
    let state = treeStateCache.get(sessionId)
    if (state) {
        treeStateCache.delete(sessionId)
        treeStateCache.set(sessionId, state)
        return state
    }

    if (treeStateCache.size >= MAX_CACHED_SESSIONS) {
        const oldestKey = treeStateCache.keys().next().value
        if (oldestKey) {
            treeStateCache.delete(oldestKey)
        }
    }

    state = {
        childrenCache: new Map(),
        expandedPaths: new Set()
    }
    treeStateCache.set(sessionId, state)
    return state
}

function FileListSkeleton(props: { label: string; rows?: number }) {
    const titleWidths = ['w-1/3', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5']
    const subtitleWidths = ['w-1/2', 'w-2/3', 'w-3/4', 'w-1/3']
    const rows = props.rows ?? 6

    return (
        <div className="p-3 animate-pulse space-y-3" role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            {Array.from({ length: rows }).map((_, index) => (
                <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="flex-1 space-y-2">
                        <div className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                        <div className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                    </div>
                </div>
            ))}
        </div>
    )
}

function ChevronIcon(props: { className?: string; expanded: boolean }) {
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
            className={`${props.className ?? ''} transition-transform ${props.expanded ? 'rotate-90' : ''}`}
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

function TreeNode(props: {
    entry: TreeEntry
    depth: number
    api: ApiClient
    sessionId: string
    treeState: LazyTreeState
    onOpenFile: (path: string) => void
    onToggle: () => void
    onStateChange: () => void
}) {
    const [loading, setLoading] = useState(false)
    const expanded = props.treeState.expandedPaths.has(props.entry.path)
    const cached = props.treeState.childrenCache.get(props.entry.path)
    const children = cached && 'entries' in cached ? cached.entries : null
    const loadError = cached && 'error' in cached ? cached.error : null

    const toggle = useCallback(async () => {
        if (props.entry.type === 'file') {
            props.onOpenFile(props.entry.path)
            return
        }
        if (expanded) {
            props.treeState.expandedPaths.delete(props.entry.path)
            props.onToggle()
            props.onStateChange()
            return
        }
        if (!cached || loadError) {
            setLoading(true)
            try {
                const res = await props.api.browseSessionTree(props.sessionId, props.entry.path)
                if (res.success) {
                    props.treeState.childrenCache.set(props.entry.path, { entries: res.entries ?? [] })
                } else {
                    props.treeState.childrenCache.set(props.entry.path, { error: res.error ?? 'Failed to load' })
                }
            } catch (e) {
                props.treeState.childrenCache.set(props.entry.path, { error: e instanceof Error ? e.message : 'Failed to load' })
            } finally {
                setLoading(false)
            }
        }
        props.treeState.expandedPaths.add(props.entry.path)
        props.onToggle()
        props.onStateChange()
    }, [expanded, cached, loadError, props])

    const isDir = props.entry.type === 'directory'
    const paddingLeft = 12 + props.depth * 20

    return (
        <div>
            <button
                type="button"
                onClick={toggle}
                className="flex w-full items-center gap-1.5 py-1.5 pr-3 text-left hover:bg-[var(--app-subtle-bg)] transition-colors text-sm"
                style={{ paddingLeft }}
            >
                {isDir ? (
                    <>
                        <ChevronIcon expanded={expanded} className="text-[var(--app-hint)] shrink-0" />
                        <FolderIcon className={expanded ? 'text-[var(--app-link)] shrink-0' : 'text-[var(--app-hint)] shrink-0'} />
                    </>
                ) : (
                    <>
                        <span className="w-4 shrink-0" />
                        <FileIcon fileName={props.entry.name} size={22} />
                    </>
                )}
                <span className="truncate">{props.entry.name}</span>
                {loading ? <span className="ml-auto text-xs text-[var(--app-hint)]">...</span> : null}
            </button>
            {expanded ? (
                <div>
                    {loadError ? (
                        <div className="text-xs text-red-500 py-1" style={{ paddingLeft: paddingLeft + 20 }}>
                            {loadError} (tap to retry)
                        </div>
                    ) : children ? (
                        <>
                            {children.map((child) => (
                                <TreeNode
                                    key={child.path}
                                    entry={child}
                                    depth={props.depth + 1}
                                    api={props.api}
                                    sessionId={props.sessionId}
                                    treeState={props.treeState}
                                    onOpenFile={props.onOpenFile}
                                    onToggle={props.onToggle}
                                    onStateChange={props.onStateChange}
                                />
                            ))}
                            {children.length === 0 ? (
                                <div className="text-xs text-[var(--app-hint)] py-1" style={{ paddingLeft: paddingLeft + 20 }}>
                                    Empty directory
                                </div>
                            ) : null}
                        </>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

export function LazyFileTree(props: {
    api: ApiClient
    sessionId: string
    treeState: LazyTreeState
    onOpenFile: (path: string) => void
    onStateChange: () => void
}) {
    const [, forceUpdate] = useState(0)
    const rootCached = props.treeState.childrenCache.get('')
    const rootEntries = rootCached && 'entries' in rootCached ? rootCached.entries : null
    const [loading, setLoading] = useState(!rootCached)
    const [error, setError] = useState<string | null>(
        rootCached && 'error' in rootCached ? rootCached.error : null
    )

    useEffect(() => {
        if (rootCached) return
        let cancelled = false
        setLoading(true)
        setError(null)
        props.api.browseSessionTree(props.sessionId).then((res) => {
            if (cancelled) return
            if (res.success) {
                props.treeState.childrenCache.set('', { entries: res.entries ?? [] })
            } else {
                const errMsg = res.error ?? 'Failed to load files'
                props.treeState.childrenCache.set('', { error: errMsg })
                setError(errMsg)
            }
        }).catch((e) => {
            if (!cancelled) {
                const errMsg = e instanceof Error ? e.message : 'Failed to load files'
                props.treeState.childrenCache.set('', { error: errMsg })
                setError(errMsg)
            }
        }).finally(() => {
            if (!cancelled) {
                setLoading(false)
                forceUpdate((n) => n + 1)
            }
        })
        return () => { cancelled = true }
    }, [props.api, props.sessionId, rootCached, props.treeState])

    const triggerRerender = useCallback(() => {
        forceUpdate((n) => n + 1)
    }, [])

    if (loading) return <FileListSkeleton label="Loading file tree..." />
    if (error) return <div className="p-6 text-sm text-red-500">{error}</div>

    const entries = rootEntries ?? []
    if (entries.length === 0) return <div className="p-6 text-sm text-[var(--app-hint)]">No files found.</div>

    return (
        <div className="py-1">
            {entries.map((entry) => (
                <TreeNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    api={props.api}
                    sessionId={props.sessionId}
                    treeState={props.treeState}
                    onOpenFile={props.onOpenFile}
                    onToggle={triggerRerender}
                    onStateChange={props.onStateChange}
                />
            ))}
        </div>
    )
}

