import type { ToolCallBlock } from '@hapi/protocol/chat'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getHapiSendCommand } from '@/chat/hapiSendCommand'
import { collectToolDetails } from '@/chat/toolGroupHydration'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ToolDetailDialogContent, ToolStatusIcon } from '@/components/ToolCard/ToolCard'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { useTranslation } from '@/lib/use-translation'

export function HapiSendMessage(props: { block: ToolCallBlock }) {
    const ctx = useHappyChatContext()
    const { t } = useTranslation()
    const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
    const [hydratedBlock, setHydratedBlock] = useState<ToolCallBlock | null>(null)

    useEffect(() => {
        setDetailState('idle')
        setHydratedBlock(null)
    }, [props.block.id])

    const fetchDetail = useCallback(() => {
        const span = props.block.tool.groupSpan
        if (!props.block.tool.resultPending || !span || !ctx.api || !ctx.sessionId) return

        setDetailState('loading')
        void ctx.api.getToolGroupMessages(ctx.sessionId, span)
            .then((response) => {
                const detail = collectToolDetails(response.messages).get(props.block.id)
                setHydratedBlock({
                    ...props.block,
                    tool: {
                        ...props.block.tool,
                        input: detail?.input ?? props.block.tool.input,
                        result: detail?.result,
                        resultPending: false
                    }
                })
                setDetailState('ready')
            })
            .catch(() => setDetailState('failed'))
    }, [ctx.api, ctx.sessionId, props.block])

    const handleOpenChange = useCallback((open: boolean) => {
        if (open && detailState === 'idle') fetchDetail()
    }, [detailState, fetchDetail])

    const displayBlock = hydratedBlock ?? props.block
    const parsed = useMemo(
        () => getHapiSendCommand(displayBlock.tool.name, displayBlock.tool.input),
        [displayBlock]
    )
    if (!parsed) return null

    const permission = props.block.tool.permission
    const showPermission = Boolean(ctx.api && permission && (
        permission.status === 'pending'
        || ((permission.status === 'denied' || permission.status === 'canceled') && Boolean(permission.reason))
    ))

    return (
        <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
            <div className="mx-auto w-full max-w-[92%] rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-2.5 shadow-sm dark:border-sky-900 dark:bg-sky-950/30">
                <Dialog onOpenChange={handleOpenChange}>
                    <DialogTrigger asChild>
                        <button type="button" className="block w-full text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                        <div className="flex items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
                            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M4 12h15" />
                                <path d="m14 7 5 5-5 5" />
                            </svg>
                            <span>Sent to session</span>
                            {parsed.target ? <span className="min-w-0 truncate font-mono font-medium">{parsed.target}</span> : null}
                            <span className="ml-auto shrink-0 text-[var(--app-hint)]">
                                <ToolStatusIcon state={props.block.tool.state} />
                            </span>
                        </div>
                        {parsed.message ? (
                            <div className="mt-2 text-sm text-[var(--app-fg)]">
                                <MarkdownRenderer content={parsed.message} />
                            </div>
                        ) : null}
                        </button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl" aria-describedby={undefined}>
                    <DialogHeader>
                        <DialogTitle>Sent to session {parsed.target ?? ''}</DialogTitle>
                    </DialogHeader>
                    {detailState === 'loading' ? (
                        <div className="py-6 text-center text-xs text-[var(--app-hint)]">{t('toolGroup.loadingToolResult')}</div>
                    ) : detailState === 'failed' ? (
                        <div className="flex flex-col items-center gap-2 py-6 text-xs text-[var(--app-hint)]">
                            <span>{t('toolGroup.toolResultFailed')}</span>
                            <button type="button" onClick={fetchDetail} className="rounded-[12px] border border-[var(--app-border)] px-3 py-1 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]">
                                {t('toolGroup.retry')}
                            </button>
                        </div>
                    ) : (
                        <ToolDetailDialogContent block={displayBlock} metadata={ctx.metadata} />
                    )}
                    </DialogContent>
                </Dialog>
                {showPermission && ctx.api ? (
                    <PermissionFooter
                        api={ctx.api}
                        sessionId={ctx.sessionId}
                        metadata={ctx.metadata}
                        tool={props.block.tool}
                        disabled={ctx.disabled}
                        onDone={ctx.onRefresh}
                    />
                ) : null}
            </div>
        </div>
    )
}
