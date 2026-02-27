import { useState } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { buildUserMessageDomId } from '@/components/AssistantChat/messages/domIds'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { useTranslation } from '@/lib/use-translation'

const CONTEXT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation'

function ForkIcon(props: { className?: string }) {
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
            className={props.className}
        >
            <circle cx="12" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
            <path d="M12 12v3" />
        </svg>
    )
}

export function HappyUserMessage() {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const role = useAssistantState(({ message }) => message.role)
    const messageId = useAssistantState(({ message }) => message.id)
    const text = useAssistantState(({ message }) => {
        if (message.role !== 'user') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const status = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.status
    })
    const localId = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.localId ?? null
    })
    const seq = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.seq ?? null
    })
    const attachments = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })

    if (role !== 'user') return null
    const canRetry = status === 'failed' && typeof localId === 'string' && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry ? () => ctx.onRetryMessage!(localId) : undefined
    const canFork = typeof seq === 'number' && Boolean(ctx.onForkFromMessage)
    const onFork = canFork ? () => ctx.onForkFromMessage!(seq) : undefined

    const userBubbleClass = 'group/msg w-fit min-w-0 max-w-[92%] ml-auto rounded-xl bg-green-50 dark:bg-green-950/30 px-3 py-2 text-[var(--app-fg)] shadow-sm'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root id={buildUserMessageDomId(messageId)} className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                </div>
            </MessagePrimitive.Root>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0
    const isContextSummary = hasText && text.startsWith(CONTEXT_SUMMARY_PREFIX)
    const [summaryExpanded, setSummaryExpanded] = useState(false)

    if (isContextSummary) {
        return (
            <MessagePrimitive.Root id={buildUserMessageDomId(messageId)} className={userBubbleClass}>
                <button
                    type="button"
                    onClick={() => setSummaryExpanded(v => !v)}
                    className="flex items-center gap-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors w-full text-left"
                >
                    <span className={`transition-transform ${summaryExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                    <span>Context summary</span>
                </button>
                {summaryExpanded && (
                    <div className="mt-2 text-sm">
                        <LazyRainbowText text={text} />
                    </div>
                )}
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root id={buildUserMessageDomId(messageId)} className={userBubbleClass}>
            <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                    {hasText && <LazyRainbowText text={text} />}
                    {hasAttachments && <MessageAttachments attachments={attachments} />}
                </div>
                {status ? (
                    <div className="shrink-0 self-end pb-0.5">
                        <MessageStatusIndicator status={status} onRetry={onRetry} />
                    </div>
                ) : null}
            </div>
            {onFork ? (
                <div className="flex justify-end mt-1 -mb-1 -mr-1 opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 transition-opacity">
                    <button
                        type="button"
                        onClick={onFork}
                        className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                        title={t('session.action.fork')}
                    >
                        <ForkIcon />
                    </button>
                </div>
            ) : null}
        </MessagePrimitive.Root>
    )
}
