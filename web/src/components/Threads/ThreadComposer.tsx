import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessage as RuntimeMessage } from '@assistant-ui/react'
import { forwardRef, useMemo, useRef, useState } from 'react'
import type { ThreadMessage } from '@hapi/protocol/threads'
import { ChatComposer, type ChatComposerHandle, type ComposerSuggestions } from '@/components/Composer/ChatComposer'
import { useAppContext } from '@/lib/app-context'
import { memberName, threadButton, type Member } from './types'

const NO_MESSAGES: RuntimeMessage[] = []

/** The composer of a thread: mentions and replies travel with the text, which threads send as plain messages. */
export const ThreadComposer = forwardRef<ChatComposerHandle, {
    members: Member[]
    reply?: ThreadMessage
    onCancelReply: () => void
    onSend: (input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }) => Promise<boolean>
}>(function ThreadComposer({ members, reply, onCancelReply, onSend }, ref) {
    const { api } = useAppContext()
    const [mentions, setMentions] = useState<string[]>([])
    const [sending, setSending] = useState(false)
    const attempt = useRef<{ key: string; id: string } | null>(null)
    const validMentions = mentions.filter(id => members.some(member => member.id === id))

    const onNew = async (message: AppendMessage) => {
        const text = message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
        // A retry of the same message reuses its id, so the hub can drop a duplicate of a lost response.
        const key = JSON.stringify([text, validMentions, reply?.id])
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        setSending(true)
        try {
            if (await onSend({ text, mentions: validMentions, replyTo: reply?.id, clientMessageId: attempt.current.id })) {
                setMentions([])
                onCancelReply()
                attempt.current = null
            } else if (!runtime.thread.composer.getState().text) {
                runtime.thread.composer.setText(text)
            }
        } finally {
            setSending(false)
        }
    }
    // A new adapter object makes the runtime notify its subscribers, so it must stay stable across renders.
    const latestOnNew = useRef(onNew)
    latestOnNew.current = onNew
    const adapter = useMemo(() => ({
        messages: NO_MESSAGES,
        isRunning: false,
        onNew: (message: AppendMessage) => latestOnNew.current(message)
    }), [])
    const runtime = useExternalStoreRuntime<RuntimeMessage>(adapter)

    const suggestions = useMemo<ComposerSuggestions>(() => ({
        prefixes: ['@'],
        load: async query => {
            const needle = query.slice(1).toLowerCase()
            return members
                .filter(member => member.kind === 'session' && !mentions.includes(member.id)
                    && `${memberName(member)} ${member.id}`.toLowerCase().includes(needle))
                .map(member => ({
                    key: member.id,
                    text: '',
                    label: memberName(member),
                    description: member.mentionWake ? member.status : `${member.status} · muted`
                }))
        },
        resolve: suggestion => {
            setMentions(previous => [...previous, suggestion.key])
            return { text: '', addSpace: false }
        }
    }), [members, mentions])

    const replyMember = reply?.sender.kind === 'session'
        ? members.find(member => reply.sender.kind === 'session' && member.id === reply.sender.sessionId)
        : undefined
    const memberTitle = (id: string) => members.find(member => member.id === id)?.title

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <ChatComposer
                ref={ref}
                items={['quickPhrases']}
                disabled={sending}
                placeholder="Message the thread · @ to mention"
                ariaLabel="Message"
                canSendEmpty={validMentions.length > 0}
                api={api}
                suggestions={suggestions}
                inputHeader={reply || mentions.length ? (
                    <div className="space-y-2 px-4 pt-3">
                        {reply ? (
                            <div className="flex items-center gap-2 border-l-2 border-[var(--app-link)] px-2 text-sm">
                                <div className="min-w-0 flex-1">
                                    <span className="text-[var(--app-hint)]">Replying to #{reply.seq}</span>
                                    <p className="truncate">{reply.text}</p>
                                    {replyMember ? (
                                        <p className="text-xs text-[var(--app-link)]">
                                            Notifies @{memberName(replyMember)}
                                            {!replyMember.mentionWake ? ' (muted)' : replyMember.status === 'inactive' ? ' (inactive)' : ''}
                                        </p>
                                    ) : null}
                                </div>
                                <button type="button" className={threadButton} aria-label="Cancel reply" onClick={onCancelReply} disabled={sending}>✕</button>
                            </div>
                        ) : null}
                        {mentions.length ? (
                            <div className="flex flex-wrap gap-1">
                                {mentions.map(id => (
                                    <button
                                        type="button"
                                        key={id}
                                        className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-link)]"
                                        disabled={sending}
                                        onClick={() => setMentions(previous => previous.filter(value => value !== id))}
                                        aria-label={`Remove mention ${memberTitle(id) ?? id}`}
                                    >
                                        @{memberTitle(id) ?? id.slice(0, 8)} ×
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </div>
                ) : null}
            />
        </AssistantRuntimeProvider>
    )
})
