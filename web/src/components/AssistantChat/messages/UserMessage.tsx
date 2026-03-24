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
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

const CONTEXT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation'

function BotIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M15 13v2" />
            <path d="M9 13v2" />
        </svg>
    )
}

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
    const { copied, copy } = useCopyToClipboard()
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
    const attachments = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const sentFrom = useAssistantState(({ message }) => {
        if (message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.sentFrom
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
    const seq = useAssistantState(({ message }) => {
        if (message.role !== 'user') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return typeof custom?.seq === 'number' ? custom.seq : null
    })
    const { trimMode, onTrim } = useHappyChatContext()

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

    const isBotMessage = sentFrom === 'cli'

    return (
        <MessagePrimitive.Root id={buildUserMessageDomId(messageId)} className={`${userBubbleClass} group/msg`}>
            {isBotMessage && (
                <div className="flex items-center gap-1 mb-1 text-xs text-[var(--app-hint)]">
                    <BotIcon className="w-3 h-3" />
                    <span>bot</span>
                </div>
            )}
            <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                    {hasText && <LazyRainbowText text={text} />}
                    {hasAttachments && <MessageAttachments attachments={attachments} />}
                </div>
                {(hasText || status) && (
                    <div className="shrink-0 self-end pb-0.5 flex items-center gap-1">
                        {hasText && (
                            <button
                                type="button"
                                title="Copy"
                                className="opacity-60 sm:opacity-0 sm:group-hover/msg:opacity-100 transition-[opacity,background-color] p-0.5 rounded hover:bg-[var(--app-subtle-bg)]"
                                onClick={() => copy(text)}
                            >
                                {copied
                                    ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                                    : <CopyIcon className="h-3.5 w-3.5 text-[var(--app-hint)]" />}
                            </button>
                        )}
                        {status && <MessageStatusIndicator status={status} onRetry={onRetry} />}
                    </div>
                )}
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
            {trimMode && typeof seq === 'number' && onTrim ? (
                <div className="mt-1 flex flex-wrap justify-end gap-1">
                    <button
                        type="button"
                        onClick={() => onTrim({ mode: 'before', seq })}
                        className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        {t('session.trim.before')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onTrim({ mode: 'after', seq })}
                        className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[10px] text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        {t('session.trim.after')}
                    </button>
                    <button
                        type="button"
                        onClick={() => onTrim({ mode: 'single', seq })}
                        className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[10px] text-red-500 hover:bg-red-500/10"
                    >
                        {t('session.trim.delete')}
                    </button>
                </div>
            ) : null}
        </MessagePrimitive.Root>
    )
}
