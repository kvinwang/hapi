import {
    AssistantRuntimeProvider,
    MessageProvider,
    useExternalStoreRuntime,
    useExternalMessageConverter,
    type ThreadMessageLike
} from '@assistant-ui/react'
import { threadMemberId, type ThreadMessage } from '@hapi/protocol/threads'
import type { ApiClient } from '@/api/client'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { QuickPhraseButton } from '@/components/QuickPhraseButton'
import { useState } from 'react'
import { ThreadAvatar } from './ThreadAvatar'
import { threadInput } from './types'

/** Edit and recall, offered only where `can*` allows; the hub enforces the same rules. */
export type ThreadMessageActions = {
    canEdit: (message: ThreadMessage) => boolean
    canRecall: (message: ThreadMessage) => boolean
    edit: (message: ThreadMessage, text: string) => Promise<boolean>
    recall: (message: ThreadMessage) => Promise<boolean>
}

function EditMessage({ message, onSave, onCancel }: { message: ThreadMessage; onSave: (text: string) => Promise<boolean>; onCancel: () => void }) {
    const [text, setText] = useState(message.text)
    const [saving, setSaving] = useState(false)
    const save = async () => {
        setSaving(true)
        if (await onSave(text.trim())) onCancel()
        setSaving(false)
    }
    return (
        <div className="space-y-2">
            <textarea
                aria-label="Edit message"
                className={`${threadInput} min-h-24 text-sm`}
                value={text}
                autoFocus
                disabled={saving}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Escape') onCancel()
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void save()
                }}
            />
            <div className="flex justify-end gap-2 text-sm">
                <button type="button" className="rounded-lg px-3 py-1 hover:bg-[var(--app-subtle-bg)]" disabled={saving} onClick={onCancel}>Cancel</button>
                <button type="button" aria-label="Save edit" className="rounded-lg bg-[var(--app-link)] px-3 py-1 text-white disabled:opacity-40" disabled={saving || !text.trim() || text.trim() === message.text} onClick={() => void save()}>Save</button>
            </div>
        </div>
    )
}

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
    showReceipts = false,
    actions
}: {
    messages: ThreadMessage[]
    name: (id: string) => string
    onReply?: (message: ThreadMessage) => void
    api?: ApiClient
    showReceipts?: boolean
    actions?: ThreadMessageActions
}) {
    const [editing, setEditing] = useState<string>()
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
                const senderId = threadMemberId(message.sender)
                const previous = messages[index - 1]
                const continued = previous && threadMemberId(previous.sender) === senderId
                const quoted = messages.find(candidate => candidate.id === message.replyTo)
                const reads = message.receipts.filter(receipt => receipt.readAt).length
                const delivered = message.receipts.filter(receipt => receipt.deliveredAt).length
                return (
                    <article
                        id={`thread-message-${message.id}`}
                        key={message.id}
                        className={`flex gap-2 ${human ? 'justify-end' : 'justify-start'}`}
                    >
                        {message.sender.kind !== 'user' && (
                            continued ? <span className="w-7 shrink-0" /> : <ThreadAvatar id={senderId} kind={message.sender.kind} />
                        )}
                        <div className="min-w-0 max-w-[92%]">
                            <div
                                className={`mb-1 flex items-center gap-2 text-xs text-[var(--app-hint)] ${human ? 'justify-end' : ''}`}
                            >
                                <span className="font-medium">{message.sender.kind === 'guest' ? `${message.sender.name} (guest)` : message.sender.kind === 'user' && message.sender.guest ? 'Guest' : name(senderId)}</span>
                                <time
                                    dateTime={new Date(message.createdAt).toISOString()}
                                    title={new Date(message.createdAt).toLocaleString()}
                                >
                                    {new Date(message.createdAt).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit'
                                    })}
                                </time>
                                {message.editedAt && !message.recalledAt && (
                                    <span title={new Date(message.editedAt).toLocaleString()}>(edited)</span>
                                )}
                            </div>
                            <div
                                className={`min-w-0 ${human ? 'rounded-2xl rounded-tr-sm bg-green-50 px-4 py-3 dark:bg-green-950/30' : ''}`}
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
                                        {quoted?.recalledAt ? '↩ A recalled message' : quoted ? `↩ ${quoted.text.slice(0, 120)}` : '↩ Reply to an earlier message'}
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
                                    {message.recalledAt ? (
                                        <p className="text-sm italic text-[var(--app-hint)]">This message was recalled</p>
                                    ) : editing === message.id && actions ? (
                                        <EditMessage message={message} onSave={text => actions.edit(message, text)} onCancel={() => setEditing(undefined)} />
                                    ) : message.text ? (
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
                                {onReply && !message.recalledAt && (
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
                                {actions && !message.recalledAt && editing !== message.id && actions.canEdit(message) && (
                                    <button className="py-1 hover:text-[var(--app-link)]" onClick={() => setEditing(message.id)}>
                                        Edit
                                    </button>
                                )}
                                {actions && !message.recalledAt && actions.canRecall(message) && (
                                    <button
                                        className="py-1 hover:text-red-500"
                                        onClick={() => {
                                            if (window.confirm('Recall this message? Members who already read it keep what they read.')) void actions.recall(message)
                                        }}
                                    >
                                        Recall
                                    </button>
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
