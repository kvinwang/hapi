import {
    AssistantRuntimeProvider,
    MessageProvider,
    useExternalStoreRuntime,
    useExternalMessageConverter,
    type ThreadMessageLike
} from '@assistant-ui/react'
import type { ThreadMessage } from '@hapi/protocol/threads'
import type { ApiClient } from '@/api/client'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { QuickPhraseButton } from '@/components/QuickPhraseButton'

function toChatMessage(message: ThreadMessage): ThreadMessageLike {
    return {
        id: message.id,
        role: message.sender.kind === 'user' ? 'user' : 'assistant',
        content: [{ type: 'text', text: message.text }],
        createdAt: new Date(message.createdAt)
    }
}

export function ThreadMessages({
    messages,
    name,
    onReply,
    api,
    showReceipts = false
}: {
    messages: ThreadMessage[]
    name: (id: string) => string
    onReply?: (message: ThreadMessage) => void
    api?: ApiClient
    showReceipts?: boolean
}) {
    const renderedMessages = useExternalMessageConverter<ThreadMessage>({
        messages,
        isRunning: false,
        joinStrategy: 'none',
        callback: toChatMessage
    })
    const runtime = useExternalStoreRuntime({
        messages: renderedMessages,
        isRunning: false,
        isDisabled: true,
        onNew: async () => {}
    })
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            {messages.map((message, index) => {
                const human = message.sender.kind === 'user'
                const senderId = message.sender.kind === 'session' ? message.sender.sessionId : 'user'
                const quoted = messages.find(candidate => candidate.id === message.replyTo)
                const reads = message.receipts.filter(receipt => receipt.readAt).length
                const delivered = message.receipts.filter(receipt => receipt.deliveredAt).length
                return (
                    <article
                        id={`thread-message-${message.id}`}
                        key={message.id}
                        className={`flex ${human ? 'justify-end' : 'justify-start'}`}
                    >
                        <div className="min-w-0 max-w-[92%]">
                            <div
                                className={`mb-1 flex items-center gap-2 text-xs text-[var(--app-hint)] ${human ? 'justify-end' : ''}`}
                            >
                                <span className="font-medium">{message.sender.kind === 'user' && message.sender.guest ? 'Guest' : name(senderId)}</span>
                                <time
                                    dateTime={new Date(message.createdAt).toISOString()}
                                    title={new Date(message.createdAt).toLocaleString()}
                                >
                                    {new Date(message.createdAt).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit'
                                    })}
                                </time>
                            </div>
                            <div
                                className={`min-w-0 rounded-2xl px-4 py-3 ${human ? 'rounded-tr-sm bg-green-50 dark:bg-green-950/30' : 'rounded-tl-sm bg-[var(--app-subtle-bg)]'}`}
                            >
                                {message.replyTo && (
                                    <button
                                        className="mb-2 block max-w-full truncate border-l-2 border-[var(--app-link)] pl-2 text-left text-sm text-[var(--app-hint)]"
                                        onClick={() =>
                                            document
                                                .getElementById(`thread-message-${message.replyTo}`)
                                                ?.scrollIntoView({
                                                    block: 'center',
                                                    behavior: 'smooth'
                                                })
                                        }
                                    >
                                        {quoted ? `↩ ${quoted.text.slice(0, 120)}` : '↩ Reply to an earlier message'}
                                    </button>
                                )}
                                {!!message.mentions.length && (
                                    <div className="mb-1 flex flex-wrap gap-2 text-xs text-[var(--app-link)]">
                                        {message.mentions.map(id => (
                                            <span key={id}>@{name(id)}</span>
                                        ))}
                                    </div>
                                )}
                                <MessageProvider index={index} message={renderedMessages[index]}>
                                    {message.text ? (
                                        <MarkdownRenderer content={message.text} />
                                    ) : (
                                        <p className="text-sm text-[var(--app-hint)]">
                                            Requested attention to the conversation
                                        </p>
                                    )}
                                </MessageProvider>
                            </div>
                            <div
                                className={`mt-1 flex items-center gap-3 text-xs text-[var(--app-hint)] ${human ? 'justify-end' : ''}`}
                            >
                                {onReply && (
                                    <button
                                        className="py-1 hover:text-[var(--app-link)]"
                                        onClick={() => onReply?.(message)}
                                    >
                                        Reply
                                    </button>
                                )}
                                {api && human && message.text.trim() && (
                                    <QuickPhraseButton api={api} text={message.text} />
                                )}
                                {showReceipts && (
                                    <details>
                                        <summary className="cursor-pointer py-1">
                                            {reads
                                                ? `Read by ${reads}`
                                                : delivered
                                                  ? `Delivered to ${delivered}`
                                                  : 'Saved'}
                                        </summary>
                                        <ul className="space-y-1 py-1">
                                            {message.receipts.map(receipt => (
                                                <li key={receipt.memberId}>
                                                    {name(receipt.memberId)}:{' '}
                                                    {receipt.readAt
                                                        ? 'Read'
                                                        : receipt.deliveredAt
                                                          ? 'Delivered'
                                                          : 'Saved'}
                                                    {receipt.wakeStatus
                                                        ? ` · ${receipt.wakeStatus}${receipt.reason ? ` (${receipt.reason})` : ''}`
                                                        : ''}
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                            </div>
                        </div>
                    </article>
                )
            })}
        </AssistantRuntimeProvider>
    )
}
