import { useState } from 'react'
import { MessagePrimitive, useAssistantState, useMessagePartText } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { getAssistantMessageIndex } from '@/components/AssistantChat/messages/assistant-message-index'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { useTranslation } from '@/lib/use-translation'
import { isClaudeStopHookFeedback } from '@/chat/messageClassification'
import { MessageUsageButton } from '@/components/AssistantChat/messages/MessageUsageButton'
import { formatMessageTimestamp } from '@/chat/presentation'

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

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

function formatAgentLabel(flavor: string): string {
    if (flavor === 'opencode') return 'OpenCode'
    return flavor.charAt(0).toUpperCase() + flavor.slice(1)
}

function AssistantText() {
    const { t } = useTranslation()
    const part = useMessagePartText()
    const [expanded, setExpanded] = useState(false)

    if (!isClaudeStopHookFeedback(part.text)) return <MarkdownText />

    return (
        <div>
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded(value => !value)}
                className="flex w-full items-center gap-1.5 py-1 text-left text-xs text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
            >
                <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9654;</span>
                <span>{t('chat.stopHookFeedback')}</span>
            </button>
            {expanded ? <div className="mt-1"><MarkdownText /></div> : null}
        </div>
    )
}

const MESSAGE_PART_COMPONENTS = {
    Text: AssistantText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const { t, locale } = useTranslation()
    const ctx = useHappyChatContext()
    const messageId = useAssistantState(({ message }) => message.id)
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const forkSeq = useAssistantState(({ message, thread }) => {
        if (message.role !== 'assistant') return null
        return getAssistantMessageIndex(thread.messages).forkSeqById.get(message.id) ?? null
    })
    const isLastMessage = useAssistantState(({ message, thread }) => (
        getAssistantMessageIndex(thread.messages).lastMessageId === message.id
    ))

    const canFork = !toolOnly && !isCliOutput && (
        typeof forkSeq === 'number'
            ? Boolean(ctx.onForkFromMessage)
            : typeof ctx.maxBlockSeq === 'number' && Boolean(ctx.onForkFromMessage)
    )
    const effectiveForkSeq = forkSeq ?? ctx.maxBlockSeq
    const onFork = canFork && typeof effectiveForkSeq === 'number'
        ? () => ctx.onForkFromMessage!(effectiveForkSeq)
        : undefined
    const flavor = ctx.metadata?.flavor ?? 'claude'
    const onForkFull = isLastMessage
        && (flavor === 'claude' || flavor === 'grok')
        && typeof ctx.maxBlockSeq === 'number'
        && ctx.onForkFullHistory
        ? () => ctx.onForkFullHistory!(ctx.maxBlockSeq!)
        : undefined

    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'group/msg px-1 min-w-0 max-w-full overflow-x-hidden'

    const contextSummaryText = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return null
        if (message.content.length !== 1) return null
        const part = message.content[0]
        if (part?.type !== 'text') return null
        if (!part.text.startsWith(CONTEXT_SUMMARY_PREFIX)) return null
        return part.text
    })
    const [summaryExpanded, setSummaryExpanded] = useState(false)
    const seq = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return typeof custom?.seq === 'number' ? custom.seq : null
    })
    const createdAt = useAssistantState(({ message }) => message.createdAt)
    const messageAgentFlavor = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.agentFlavor
    })
    const messageAgentModel = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.agentModel
    })
    const driverSeq = seq ?? effectiveForkSeq
    const segmentFlavor = typeof driverSeq === 'number'
        ? ctx.metadata?.agentDriverSegments?.find(segment => driverSeq >= segment.fromSeq && driverSeq <= segment.toSeq)?.flavor
        : undefined
    const agentFlavor = messageAgentFlavor ?? segmentFlavor ?? (
        ctx.metadata?.agentDriverSegments?.length ? undefined : ctx.metadata?.flavor
    )
    const timestamp = createdAt ? formatMessageTimestamp(createdAt.getTime(), Date.now(), locale) : null
    const { trimMode, onTrim } = useHappyChatContext()

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root data-happy-message-id={messageId} className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <CliOutputBlock text={cliText} />
            </MessagePrimitive.Root>
        )
    }

    if (contextSummaryText) {
        return (
            <MessagePrimitive.Root data-happy-message-id={messageId} className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <button
                    type="button"
                    onClick={() => setSummaryExpanded(v => !v)}
                    className="flex items-center gap-1.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors w-full text-left py-1"
                >
                    <span className={`transition-transform ${summaryExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                    <span>Context summary</span>
                </button>
                {summaryExpanded && (
                    <div className="mt-1">
                        <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                    </div>
                )}
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root data-happy-message-id={messageId} className={rootClass}>
            <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
            {!toolOnly ? (
                <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--app-hint)]">
                    {onFork ? (
                        <>
                            <button
                                type="button"
                                onClick={onFork}
                                className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                title={t('session.action.fork')}
                            >
                                <ForkIcon />
                            </button>
                            <MessageUsageButton seq={effectiveForkSeq!} />
                        </>
                    ) : null}
                    {onForkFull ? (
                        <button
                            type="button"
                            onClick={onForkFull}
                            className="relative p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                            title={t('session.action.forkFull')}
                        >
                            <ForkIcon />
                            <span className="absolute -right-1 -top-1 text-[8px] font-bold">∞</span>
                        </button>
                    ) : null}
                    {agentFlavor ? <span className="ml-1">{formatAgentLabel(agentFlavor)}</span> : null}
                    {agentFlavor && messageAgentModel ? <span aria-hidden="true">·</span> : null}
                    {messageAgentModel ? <span>{messageAgentModel}</span> : null}
                    {(agentFlavor || messageAgentModel) && timestamp ? <span aria-hidden="true">·</span> : null}
                    {timestamp ? <time dateTime={createdAt?.toISOString()} title={createdAt?.toLocaleString()}>{timestamp}</time> : null}
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
