import { useState } from 'react'
import type { UsageData } from '@hapi/protocol/chat'
import { getContextTokens } from '@/chat/messageUsage'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { useTranslation } from '@/lib/use-translation'

function InfoIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
        </svg>
    )
}

function formatTokens(value: number): string {
    return Math.max(0, value).toLocaleString()
}

function InfoRow(props: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between gap-6 py-1.5 text-sm">
            <span className="text-[var(--app-hint)]">{props.label}</span>
            <span className="font-medium tabular-nums text-[var(--app-fg)]">{props.value}</span>
        </div>
    )
}

export function MessageUsageButton(props: { seq: number }) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [open, setOpen] = useState(false)
    const usage: UsageData | null = ctx.getUsageAtSeq?.(props.seq) ?? null
    const contextWindow = ctx.contextWindowTokens ?? undefined
    const contextTokens = usage ? getContextTokens(usage) : null
    const remaining = contextTokens !== null && contextWindow !== undefined
        ? Math.max(0, contextWindow - contextTokens)
        : null
    const remainingPercent = remaining !== null && contextWindow && contextWindow > 0
        ? Math.round((remaining / contextWindow) * 100)
        : null

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                title={t('usage.context')}
                aria-label={t('usage.context')}
            >
                <InfoIcon />
            </button>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('usage.context')}</DialogTitle>
                </DialogHeader>
                <div className="mt-3 divide-y divide-[var(--app-border)]">
                    {usage && contextTokens !== null ? (
                        <>
                            <InfoRow
                                label={t('usage.context')}
                                value={contextWindow !== undefined
                                    ? `${formatTokens(contextTokens)} / ${formatTokens(contextWindow)}`
                                    : formatTokens(contextTokens)}
                            />
                            {remaining !== null ? (
                                <InfoRow
                                    label={t('usage.available')}
                                    value={`${formatTokens(remaining)}${remainingPercent !== null ? ` (${remainingPercent}%)` : ''}`}
                                />
                            ) : null}
                            <InfoRow label={t('usage.inputTokens')} value={formatTokens(usage.input_tokens)} />
                            <InfoRow label={t('usage.outputTokens')} value={formatTokens(usage.output_tokens)} />
                            {usage.cache_creation_input_tokens !== undefined ? (
                                <InfoRow label={t('usage.cacheCreationInputTokens')} value={formatTokens(usage.cache_creation_input_tokens)} />
                            ) : null}
                            {usage.cache_read_input_tokens !== undefined ? (
                                <InfoRow label={t('usage.cacheReadInputTokens')} value={formatTokens(usage.cache_read_input_tokens)} />
                            ) : null}
                        </>
                    ) : (
                        <div className="py-3 text-sm text-[var(--app-hint)]">{t('usage.notAvailable')}</div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
