import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearch } from '@tanstack/react-router'
import type { GitCommandResponse } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { CopyIcon, CheckIcon, CloseIcon } from '@/components/icons'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTextSelection } from '@/hooks/useTextSelection'
import { queryKeys } from '@/lib/query-keys'
import { langAlias, useShikiLineHighlighter } from '@/lib/shiki'
import { decodeBase64 } from '@/lib/utils'

type Annotation = {
    id: string
    startLine: number
    endLine: number
    text: string
}

const MAX_COPYABLE_FILE_BYTES = 1_000_000

function decodePath(value: string): string {
    if (!value) return ''
    const decoded = decodeBase64(value)
    return decoded.ok ? decoded.text : value
}

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function DiffDisplay(props: { diffContent: string }) {
    const lines = props.diffContent.split('\n')

    return (
        <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
            {lines.map((line, index) => {
                const isAdd = line.startsWith('+') && !line.startsWith('+++')
                const isRemove = line.startsWith('-') && !line.startsWith('---')
                const isHunk = line.startsWith('@@')
                const isHeader = line.startsWith('+++') || line.startsWith('---')

                const className = [
                    'whitespace-pre-wrap px-3 py-0.5 text-xs font-mono',
                    isAdd ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]' : '',
                    isRemove ? 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]' : '',
                    isHunk ? 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] font-semibold' : '',
                    isHeader ? 'text-[var(--app-hint)] font-semibold' : ''
                ].filter(Boolean).join(' ')

                const style = isAdd
                    ? { borderLeft: '2px solid var(--app-git-staged-color)' }
                    : isRemove
                        ? { borderLeft: '2px solid var(--app-git-deleted-color)' }
                        : undefined

                return (
                    <div key={`${index}-${line}`} className={className} style={style}>
                        {line || ' '}
                    </div>
                )
            })}
        </div>
    )
}

function FileContentSkeleton() {
    const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-4/5']

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">Loading file…</span>
            <div className="animate-pulse space-y-2 rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3">
                {Array.from({ length: 12 }).map((_, index) => (
                    <div key={`file-skeleton-${index}`} className={`h-3 ${widths[index % widths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                ))}
            </div>
        </div>
    )
}

function resolveLanguage(path: string): string | undefined {
    const parts = path.split('.')
    if (parts.length <= 1) return undefined
    const ext = parts[parts.length - 1]?.toLowerCase()
    if (!ext) return undefined
    return langAlias[ext] ?? ext
}

function getUtf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length
}

function isBinaryContent(content: string): boolean {
    if (!content) return false
    if (content.includes('\0')) return true
    const nonPrintable = content.split('').filter((char) => {
        const code = char.charCodeAt(0)
        return code < 32 && code !== 9 && code !== 10 && code !== 13
    }).length
    return nonPrintable / content.length > 0.1
}

function extractCommandError(result: GitCommandResponse | undefined): string | null {
    if (!result) return null
    if (result.success) return null
    return result.error ?? result.stderr ?? 'Failed to load diff'
}

function FloatingAnnotateButton(props: {
    containerRef: React.RefObject<HTMLElement | null>
    selectionRect: DOMRect
    onClick: () => void
}) {
    const container = props.containerRef.current
    if (!container) return null
    const containerRect = container.getBoundingClientRect()
    const top = props.selectionRect.top - containerRect.top - 36
    const left = Math.max(0, (props.selectionRect.left + props.selectionRect.right) / 2 - containerRect.left - 40)

    return (
        <div
            className="absolute z-20"
            style={{ top: Math.max(0, top), left }}
        >
            <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); props.onClick() }}
                className="rounded-full bg-[var(--app-button)] text-[var(--app-button-text)] px-3 py-1.5 text-xs font-medium shadow-lg hover:opacity-90 transition-opacity"
            >
                + Annotate
            </button>
        </div>
    )
}

export default function FilePage() {
    const { api } = useAppContext()
    const { copied: pathCopied, copy: copyPath } = useCopyToClipboard()
    const { copied: contentCopied, copy: copyContent } = useCopyToClipboard()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/file' })
    const search = useSearch({ from: '/sessions/$sessionId/file' })
    const encodedPath = typeof search.path === 'string' ? search.path : ''
    const staged = search.staged
    const cwd = typeof search.cwd === 'string' ? search.cwd : undefined

    const filePath = useMemo(() => decodePath(encodedPath), [encodedPath])
    const fileName = filePath.split('/').pop() || filePath || 'File'

    const diffQuery = useQuery({
        queryKey: queryKeys.gitFileDiff(sessionId, filePath, staged, cwd),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.getGitDiffFile(sessionId, filePath, staged, cwd)
        },
        enabled: Boolean(api && sessionId && filePath)
    })

    const fileQuery = useQuery({
        queryKey: queryKeys.sessionFile(sessionId, filePath, cwd),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.readSessionFile(sessionId, filePath, cwd)
        },
        enabled: Boolean(api && sessionId && filePath)
    })

    const diffContent = diffQuery.data?.success ? (diffQuery.data.stdout ?? '') : ''
    const diffError = extractCommandError(diffQuery.data)
    const diffSuccess = diffQuery.data?.success === true
    const diffFailed = diffQuery.data?.success === false

    const fileContentResult = fileQuery.data
    const decodedContentResult = fileContentResult?.success && fileContentResult.content
        ? decodeBase64(fileContentResult.content)
        : { text: '', ok: true }
    const decodedContent = decodedContentResult.text
    const binaryFile = fileContentResult?.success
        ? !decodedContentResult.ok || isBinaryContent(decodedContent)
        : false

    const language = useMemo(() => resolveLanguage(filePath), [filePath])
    const highlightedLines = useShikiLineHighlighter(decodedContent, language)
    const contentLines = useMemo(() => decodedContent.split('\n'), [decodedContent])
    const contentSizeBytes = useMemo(
        () => (decodedContent ? getUtf8ByteLength(decodedContent) : 0),
        [decodedContent]
    )
    const canCopyContent = fileContentResult?.success === true
        && !binaryFile
        && decodedContent.length > 0
        && contentSizeBytes <= MAX_COPYABLE_FILE_BYTES

    const [displayMode, setDisplayMode] = useState<'diff' | 'file'>('diff')

    // Annotation state
    const [annotations, setAnnotations] = useState<Annotation[]>([])
    const [annotationDialog, setAnnotationDialog] = useState<{ startLine: number; endLine: number } | null>(null)
    const [annotationText, setAnnotationText] = useState('')
    const codeContainerRef = useRef<HTMLDivElement>(null)
    const { selection, clearSelection } = useTextSelection(codeContainerRef)
    const { copied: annotationsCopied, copy: copyAnnotations } = useCopyToClipboard()
    const { copied: dialogCopied, copy: copyDialogAnnotation } = useCopyToClipboard()

    const annotatedLines = useMemo(() => {
        const set = new Set<number>()
        for (const a of annotations) {
            for (let i = a.startLine; i <= a.endLine; i++) set.add(i)
        }
        return set
    }, [annotations])

    function formatAnnotations(): string {
        return [...annotations]
            .sort((a, b) => a.startLine - b.startLine)
            .map(a => {
                const range = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`
                return `${filePath}:${range}\n${a.text}`
            })
            .join('\n\n')
    }

    function formatCurrentAnnotation(): string {
        if (!annotationDialog) return ''
        const range = annotationDialog.startLine === annotationDialog.endLine
            ? `${annotationDialog.startLine}`
            : `${annotationDialog.startLine}-${annotationDialog.endLine}`
        return `${filePath}:${range}\n${annotationText.trim()}`
    }

    function handleAddAnnotation(e: React.FormEvent) {
        e.preventDefault()
        if (!annotationDialog || !annotationText.trim()) return
        setAnnotations(prev => [...prev, {
            id: crypto.randomUUID(),
            startLine: annotationDialog.startLine,
            endLine: annotationDialog.endLine,
            text: annotationText.trim(),
        }])
        setAnnotationDialog(null)
        setAnnotationText('')
    }

    function removeAnnotation(id: string) {
        setAnnotations(prev => prev.filter(a => a.id !== id))
    }

    useEffect(() => {
        if (diffSuccess && !diffContent) {
            setDisplayMode('file')
            return
        }
        if (diffFailed) {
            setDisplayMode('file')
        }
    }, [diffSuccess, diffFailed, diffContent])

    const loading = diffQuery.isLoading || fileQuery.isLoading
    const fileError = fileContentResult && !fileContentResult.success
        ? (fileContentResult.error ?? 'Failed to read file')
        : null
    const isDirectory = Boolean(fileError && fileError.includes('EISDIR'))
    const missingPath = !filePath

    const handleBrowseDirectory = () => goBack()

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{fileName}</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{filePath || 'Unknown path'}</div>
                    </div>
                </div>
            </div>

            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                    <FileIcon fileName={fileName} size={20} />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">{filePath}</span>
                    <button
                        type="button"
                        onClick={() => copyPath(filePath)}
                        className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                        title="Copy path"
                    >
                        {pathCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                </div>
            </div>

            {diffContent && !isDirectory ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                        <button
                            type="button"
                            onClick={() => setDisplayMode('diff')}
                            className={`rounded px-3 py-1 text-xs font-semibold ${displayMode === 'diff' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            Diff
                        </button>
                        <button
                            type="button"
                            onClick={() => setDisplayMode('file')}
                            className={`rounded px-3 py-1 text-xs font-semibold ${displayMode === 'file' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            File
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="app-scroll-y flex-1 min-h-0">
                <div className="w-full p-4">
                    {missingPath ? (
                        <div className="text-sm text-[var(--app-hint)]">No file path provided.</div>
                    ) : loading ? (
                        <FileContentSkeleton />
                    ) : isDirectory ? (
                        <div>
                            {diffContent ? (
                                <DiffDisplay diffContent={diffContent} />
                            ) : (
                                <div className="text-sm text-[var(--app-hint)]">This is a directory.</div>
                            )}
                            <button
                                type="button"
                                onClick={handleBrowseDirectory}
                                className="mt-3 inline-flex items-center gap-2 rounded-md bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)] hover:opacity-90 transition-opacity"
                            >
                                Browse this directory
                            </button>
                        </div>
                    ) : displayMode === 'diff' && diffContent ? (
                        <DiffDisplay diffContent={diffContent} />
                    ) : displayMode === 'diff' && diffError ? (
                        <div className="text-sm text-[var(--app-hint)]">{diffError}</div>
                    ) : fileError ? (
                        <div className="text-sm text-[var(--app-hint)]">{fileError}</div>
                    ) : binaryFile ? (
                        <div className="text-sm text-[var(--app-hint)]">
                            This looks like a binary file. It cannot be displayed.
                        </div>
                    ) : displayMode === 'file' ? (
                        decodedContent ? (
                            <>
                                {annotations.length > 0 && (
                                    <div className="mb-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                                        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--app-divider)]">
                                            <span className="text-xs font-medium">{annotations.length} annotation{annotations.length > 1 ? 's' : ''}</span>
                                            <button
                                                type="button"
                                                onClick={() => copyAnnotations(formatAnnotations())}
                                                className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                                            >
                                                {annotationsCopied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
                                                Copy All
                                            </button>
                                        </div>
                                        {annotations.map(a => (
                                            <div key={a.id} className="flex items-start gap-2 px-3 py-2 border-b border-[var(--app-divider)] last:border-0">
                                                <span className="shrink-0 text-xs font-mono text-[var(--app-link)]">
                                                    L{a.startLine}{a.endLine !== a.startLine ? `-${a.endLine}` : ''}
                                                </span>
                                                <span className="flex-1 text-xs whitespace-pre-wrap">{a.text}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => removeAnnotation(a.id)}
                                                    className="shrink-0 p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                                                >
                                                    <CloseIcon className="h-3 w-3" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div className="relative">
                                    {canCopyContent ? (
                                        <button
                                            type="button"
                                            onClick={() => copyContent(decodedContent)}
                                            className="absolute right-2 top-2 z-10 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                                            title="Copy file content"
                                        >
                                            {contentCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                                        </button>
                                    ) : null}
                                    <div
                                        ref={codeContainerRef}
                                        className="shiki overflow-auto rounded-md bg-[var(--app-code-bg)] py-2 pr-8 text-xs font-mono"
                                    >
                                        {contentLines.map((line, index) => {
                                            const lineNum = index + 1
                                            const isAnnotated = annotatedLines.has(lineNum)
                                            return (
                                                <div
                                                    key={lineNum}
                                                    data-line={lineNum}
                                                    className={`flex ${isAnnotated ? 'bg-[var(--app-link)]/10 border-l-2 border-[var(--app-link)]' : 'border-l-2 border-transparent'}`}
                                                >
                                                    <span className="inline-block w-10 shrink-0 text-right pr-3 text-[var(--app-hint)] select-none opacity-40">
                                                        {lineNum}
                                                    </span>
                                                    <span className="flex-1 whitespace-pre">{highlightedLines?.[index] ?? (line || ' ')}</span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                    {selection && !annotationDialog && (
                                        <FloatingAnnotateButton
                                            containerRef={codeContainerRef}
                                            selectionRect={selection.rect}
                                            onClick={() => {
                                                setAnnotationDialog({ startLine: selection.startLine, endLine: selection.endLine })
                                                setAnnotationText('')
                                                clearSelection()
                                            }}
                                        />
                                    )}
                                </div>
                                <Dialog open={annotationDialog !== null} onOpenChange={(open) => { if (!open) setAnnotationDialog(null) }}>
                                    <DialogContent className="max-w-sm">
                                        <DialogHeader>
                                            <DialogTitle>Add Annotation</DialogTitle>
                                            <DialogDescription>
                                                {annotationDialog && (
                                                    annotationDialog.startLine === annotationDialog.endLine
                                                        ? `Line ${annotationDialog.startLine}`
                                                        : `Lines ${annotationDialog.startLine}-${annotationDialog.endLine}`
                                                )}
                                            </DialogDescription>
                                        </DialogHeader>
                                        <form onSubmit={handleAddAnnotation} className="mt-3 flex flex-col gap-3">
                                            <textarea
                                                value={annotationText}
                                                onChange={(e) => setAnnotationText(e.target.value)}
                                                className="w-full px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-button)] focus:border-transparent resize-none"
                                                placeholder="Enter annotation..."
                                                rows={3}
                                                autoFocus
                                            />
                                            <div className="flex gap-2 justify-end">
                                                <Button type="button" variant="secondary" size="sm" onClick={() => setAnnotationDialog(null)}>Cancel</Button>
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    className="gap-1"
                                                    disabled={!annotationText.trim()}
                                                    onClick={() => copyDialogAnnotation(formatCurrentAnnotation())}
                                                    title="Copy location and text"
                                                >
                                                    {dialogCopied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
                                                    Copy
                                                </Button>
                                                <Button type="submit" size="sm" disabled={!annotationText.trim()}>Save</Button>
                                            </div>
                                        </form>
                                    </DialogContent>
                                </Dialog>
                            </>
                        ) : (
                            <div className="text-sm text-[var(--app-hint)]">File is empty.</div>
                        )
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">No changes to display.</div>
                    )}
                </div>
            </div>
        </div>
    )
}
