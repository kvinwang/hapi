import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { useTranslation } from '@/lib/use-translation'

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

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

export function HappyAssistantMessage() {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
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
        const messages = thread.messages
        const idx = messages.findIndex((m) => m.id === message.id)
        if (idx < 0) return null
        // Look forward for the next user message and use its seq - 1
        for (let i = idx + 1; i < messages.length; i++) {
            const m = messages[i]!
            if (m.role === 'user') {
                const custom = m.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
                if (typeof custom?.seq === 'number') return custom.seq - 1
                return null
            }
        }
        // Last assistant message — no next user message
        return null
    })

    const canFork = !toolOnly && !isCliOutput && (
        typeof forkSeq === 'number'
            ? Boolean(ctx.onForkFromMessage)
            : typeof ctx.maxBlockSeq === 'number' && Boolean(ctx.onForkFromMessage)
    )
    const effectiveForkSeq = forkSeq ?? ctx.maxBlockSeq
    const onFork = canFork && typeof effectiveForkSeq === 'number'
        ? () => ctx.onForkFromMessage!(effectiveForkSeq)
        : undefined

    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'group/msg px-1 min-w-0 max-w-full overflow-x-hidden'

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root className="px-1 min-w-0 max-w-full overflow-x-hidden">
                <CliOutputBlock text={cliText} />
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root className={rootClass}>
            <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
            {onFork ? (
                <div className="flex mt-1 opacity-100 sm:opacity-0 sm:group-hover/msg:opacity-100 transition-opacity">
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
