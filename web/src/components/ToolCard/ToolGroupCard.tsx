import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
    formatLatestToolTarget,
    type ToolGroupBlock
} from '@/chat/toolGroups'
import type { ToolCallBlock } from '@hapi/protocol/chat'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { ElapsedView, ToolDetailDialogContent, ToolStatusIcon, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { basename, resolveDisplayPath } from '@/utils/path'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'
import { collectToolDetails, toolGroupSeqSpan, type ToolDetail } from '@/chat/toolGroupHydration'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const TOOL_ROW_PAGE_SIZE = 30

type ResultsState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; byToolId: Map<string, ToolDetail> }
    | { status: 'failed' }

const IDLE_RESULTS: ResultsState = { status: 'idle' }

function DetailsIcon(props: { open: boolean }) {
    return (
        <svg
            className={cn(
                'h-4 w-4 transition-transform duration-150',
                props.open ? 'rotate-90' : 'rotate-0'
            )}
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
        >
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function SummaryBadge(props: { className: string; text: string }) {
    return (
        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', props.className)}>
            {props.text}
        </span>
    )
}

function RowStatusBadge(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    if (props.block.tool.state === 'error') {
        return <SummaryBadge className="bg-red-500/10 text-red-600" text={t('toolGroup.rowStatus.error')} />
    }
    if (props.block.tool.state === 'running') {
        return <SummaryBadge className="bg-sky-500/10 text-sky-600" text={t('toolGroup.rowStatus.running')} />
    }
    if (props.block.tool.state === 'pending') {
        return <SummaryBadge className="bg-amber-500/10 text-amber-700" text={t('toolGroup.rowStatus.pending')} />
    }
    return null
}

function formatActionSummary(block: ToolGroupBlock, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const parts: string[] = []
    const { countsByKind } = block.summary

    if (countsByKind.mutation > 0) {
        parts.push(t('toolGroup.summary.mutation', { n: countsByKind.mutation }))
    }
    if (countsByKind.read > 0) {
        parts.push(t('toolGroup.summary.read', { n: countsByKind.read }))
    }
    if (countsByKind.command > 0) {
        parts.push(t('toolGroup.summary.command', { n: countsByKind.command }))
    }
    if (countsByKind.search > 0) {
        parts.push(t('toolGroup.summary.search', { n: countsByKind.search }))
    }
    if (countsByKind.web > 0) {
        parts.push(t('toolGroup.summary.web', { n: countsByKind.web }))
    }
    if (countsByKind.other > 0) {
        parts.push(t('toolGroup.summary.other', { n: countsByKind.other }))
    }

    return parts.length > 0 ? parts.join(' · ') : null
}

function formatPrimaryTitle(block: ToolGroupBlock, metadata: SessionMetadataSummary | null, t: (key: string, params?: Record<string, string | number>) => string): string {
    return formatLatestToolTarget(
        block,
        (path) => resolveDisplayPath(path, metadata)
    ) ?? t('toolGroup.title')
}

function formatSubtitle(block: ToolGroupBlock, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    return formatActionSummary(block, t)
}

function RowLabel(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }), [props.block, props.metadata])

    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                    {presentation.icon}
                </div>
                <div className="min-w-0 truncate text-sm font-medium text-[var(--app-fg)]">
                    {presentation.title}
                </div>
            </div>
            {presentation.subtitle ? (
                <div className="mt-1 truncate font-mono text-xs text-[var(--app-tool-card-subtitle)]">
                    {truncate(presentation.subtitle, 120)}
                </div>
            ) : null}
        </div>
    )
}

function ToolGroupCardInner(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [open, setOpen] = useState(props.block.defaultOpen)
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const [visibleToolCount, setVisibleToolCount] = useState(TOOL_ROW_PAGE_SIZE)
    /**
     * Results the hub stripped from a compacted run, fetched once per group.
     * Tracked as an explicit status rather than "is it in the map", because a
     * tool with no result at all would otherwise look unfetched forever and the
     * effect would refetch on every render.
     */
    const [results, setResults] = useState<ResultsState>(IDLE_RESULTS)
    const resultFetchRunRef = useRef(0)

    useEffect(() => {
        resultFetchRunRef.current += 1
        setOpen(props.block.defaultOpen)
        setSelectedToolId(null)
        setVisibleToolCount(TOOL_ROW_PAGE_SIZE)
        setResults(IDLE_RESULTS)
    }, [props.block.id])

    // Fetch the run's raw messages the first time a detail view is opened.
    useEffect(() => {
        if (results.status !== 'idle') return
        if (selectedToolId === null) return
        const selected = props.block.tools.find((tool) => tool.id === selectedToolId)
        if (!selected?.tool.resultPending) return

        const span = toolGroupSeqSpan(props.block)
        if (!span || !ctx.api || !ctx.sessionId) return

        const runId = resultFetchRunRef.current + 1
        resultFetchRunRef.current = runId
        setResults({ status: 'loading' })
        void ctx.api.getToolGroupMessages(ctx.sessionId, span)
            .then((response) => {
                if (resultFetchRunRef.current !== runId) return
                setResults({ status: 'ready', byToolId: collectToolDetails(response.messages) })
            })
            .catch(() => {
                if (resultFetchRunRef.current !== runId) return
                setResults({ status: 'failed' })
            })
    }, [results.status, selectedToolId, props.block, ctx.api, ctx.sessionId])

    const selectedTool = useMemo(() => {
        const tool = props.block.tools.find((entry) => entry.id === selectedToolId) ?? null
        if (!tool || !tool.tool.resultPending) return tool
        if (results.status !== 'ready') return tool
        const detail = results.byToolId.get(tool.id)
        return {
            ...tool,
            tool: {
                ...tool.tool,
                // The compacted descriptor carries a truncated input; prefer the
                // real one now that the run's messages are here.
                input: detail?.input ?? tool.tool.input,
                result: detail?.result,
                resultPending: false
            }
        }
    }, [props.block.tools, selectedToolId, results])
    const selectedPresentation = useMemo(() => {
        if (!selectedTool) return null
        return getToolPresentation({
            toolName: selectedTool.tool.name,
            input: selectedTool.tool.input,
            result: selectedTool.tool.result,
            childrenCount: selectedTool.children.length,
            description: selectedTool.tool.description,
            metadata: props.metadata
        })
    }, [selectedTool, props.metadata])

    const primaryTitle = formatPrimaryTitle(props.block, props.metadata, t)
    const subtitle = formatSubtitle(props.block, t)
    const fileCount = props.block.summary.fileTargets.length
    const runningFrom = props.block.tools.reduce<number | null>((earliest, tool) => {
        if (tool.tool.state !== 'running') return earliest
        const startedAt = tool.tool.startedAt ?? tool.tool.createdAt
        return earliest === null ? startedAt : Math.min(earliest, startedAt)
    }, null)

    return (
        <Card data-tool-group className="overflow-hidden rounded-[20px] bg-[var(--app-tool-card-bg)] shadow-none">
            <CardHeader className={cn('space-y-0 p-3', subtitle ? 'pb-2' : null)}>
                <button
                    type="button"
                    onClick={(event) => ctx.mutatePreservingScroll(
                        () => setOpen((value) => !value),
                        event.currentTarget
                    )}
                    className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-expanded={open}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex flex-1 flex-col gap-1">
                            <div className="min-w-0 flex items-center gap-2">
                                <div className="shrink-0 flex h-3.5 w-3.5 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                                    <DetailsIcon open={open} />
                                </div>
                                <CardTitle className="min-w-0 break-words text-sm font-medium leading-tight text-[var(--app-fg)]">
                                    {primaryTitle}
                                </CardTitle>
                            </div>
                            {subtitle ? (
                                <CardDescription className="break-all font-mono text-xs text-[var(--app-tool-card-subtitle)]">
                                    {subtitle}
                                </CardDescription>
                            ) : null}
                        </div>

                        <div className="flex shrink-0 items-center gap-2 self-center text-[var(--app-hint)]">
                            {runningFrom !== null ? (
                                <ElapsedView from={runningFrom} active />
                            ) : null}
                            {props.block.summary.runningCount > 0 ? (
                                <SummaryBadge
                                    className="bg-sky-500/10 text-sky-600"
                                    text={t('toolGroup.badge.running', { n: props.block.summary.runningCount })}
                                />
                            ) : null}
                            {props.block.summary.pendingCount > 0 ? (
                                <SummaryBadge
                                    className="bg-amber-500/10 text-amber-700"
                                    text={t('toolGroup.badge.pending', { n: props.block.summary.pendingCount })}
                                />
                            ) : null}
                            {props.block.summary.errorCount > 0 ? (
                                <SummaryBadge
                                    className="bg-red-500/10 text-red-600"
                                    text={t('toolGroup.badge.error', { n: props.block.summary.errorCount })}
                                />
                            ) : null}
                            {fileCount > 0 ? (
                                <SummaryBadge
                                    className="bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                                    text={t('toolGroup.badge.fileTargets', { n: fileCount })}
                                />
                            ) : null}
                        </div>
                    </div>
                </button>
            </CardHeader>

            {open ? (
                <CardContent className="px-3 pb-3 pt-1">
                    <div className="mb-3 text-xs text-[var(--app-hint)]">
                        {t('toolGroup.toolCount', { n: props.block.tools.length })}
                    </div>

                    <div className="flex flex-col gap-2">
                        {props.block.tools.slice(0, visibleToolCount).map((tool) => {
                            const filePath = getInputStringAny(tool.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path'])
                            const resolvedPath = filePath ? resolveDisplayPath(filePath, props.metadata) : null
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    className="flex items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    onClick={() => setSelectedToolId(tool.id)}
                                >
                                    <span className={cn('shrink-0', toolStatusColorClass(tool.tool.state))}>
                                        <ToolStatusIcon state={tool.tool.state} />
                                    </span>
                                    <RowLabel block={tool} metadata={props.metadata} />
                                    <div className="flex shrink-0 items-center gap-2">
                                        <ElapsedView
                                            from={tool.tool.startedAt ?? tool.tool.createdAt}
                                            active={tool.tool.state === 'running'}
                                        />
                                        <RowStatusBadge block={tool} />
                                        {resolvedPath && resolvedPath !== '<root>' ? (
                                            <span className="hidden rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)] sm:inline-flex">
                                                {basename(resolvedPath)}
                                            </span>
                                        ) : null}
                                    </div>
                                </button>
                            )
                        })}
                    </div>

                    {visibleToolCount < props.block.tools.length ? (
                        <button
                            type="button"
                            onClick={() => setVisibleToolCount((count) => Math.min(
                                count + TOOL_ROW_PAGE_SIZE,
                                props.block.tools.length
                            ))}
                            className="mt-3 flex w-full items-center justify-center rounded-[12px] border border-[var(--app-border)] py-1.5 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        >
                            {t('toolGroup.showMore', {
                                n: Math.min(TOOL_ROW_PAGE_SIZE, props.block.tools.length - visibleToolCount)
                            })}
                        </button>
                    ) : null}

                    <button
                        type="button"
                        onClick={(event) => ctx.mutatePreservingScroll(
                            () => setOpen(false),
                            event.currentTarget
                        )}
                        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-[var(--app-border)] py-1.5 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <svg
                            className="h-3.5 w-3.5"
                            viewBox="0 0 16 16"
                            fill="none"
                            aria-hidden="true"
                        >
                            <path d="M3 10l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {t('toolGroup.collapse')}
                    </button>
                </CardContent>
            ) : null}

            <Dialog open={selectedTool !== null} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setSelectedToolId(null)
                }
            }}>
                <DialogContent className="max-w-2xl" aria-describedby={undefined}>
                    {selectedTool && selectedPresentation ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{selectedPresentation.title}</DialogTitle>
                            </DialogHeader>
                            {results.status === 'loading' && selectedTool.tool.resultPending ? (
                                <div className="py-6 text-center text-xs text-[var(--app-hint)]">
                                    {t('toolGroup.loadingToolResult')}
                                </div>
                            ) : results.status === 'failed' && selectedTool.tool.resultPending ? (
                                <div className="flex flex-col items-center gap-2 py-6 text-xs text-[var(--app-hint)]">
                                    <span>{t('toolGroup.toolResultFailed')}</span>
                                    <button
                                        type="button"
                                        onClick={() => setResults(IDLE_RESULTS)}
                                        className="rounded-[12px] border border-[var(--app-border)] px-3 py-1 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                    >
                                        {t('toolGroup.retry')}
                                    </button>
                                </div>
                            ) : (
                                <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
                            )}
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Card>
    )
}

export const ToolGroupCard = memo(ToolGroupCardInner)
