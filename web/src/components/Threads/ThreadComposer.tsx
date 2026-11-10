import { AssistantRuntimeProvider, useAssistantState, useExternalStoreRuntime, type AppendMessage, type ThreadMessage as RuntimeMessage } from '@assistant-ui/react'
import { forwardRef, useMemo, useRef, useState } from 'react'
import type { ThreadMessage } from '@hapi/protocol/threads'
import { ChatComposer, type ChatComposerHandle, type ComposerSuggestions } from '@/components/Composer/ChatComposer'
import { useOptionalAppContext } from '@/lib/app-context'
import { ThreadAvatar } from './ThreadAvatar'
import { memberName, mentionedIds, mentionText, threadButton, type Member } from './types'

const NO_MESSAGES: RuntimeMessage[] = []

/** The composer of a thread: `@<member id>` in the text mentions that member; replies travel with the text. */
export const ThreadComposer = forwardRef<ChatComposerHandle, {
    members: Member[]
    reply?: ThreadMessage
    onCancelReply: () => void
    onSend: (input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }) => Promise<boolean>
}>(function ThreadComposer({ members, reply, onCancelReply, onSend }, ref) {
    const api = useOptionalAppContext()?.api
    const [sending, setSending] = useState(false)
    const attempt = useRef<{ key: string; id: string } | null>(null)

    const onNew = async (message: AppendMessage) => {
        const text = message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
        const mentions = mentionedIds(text, members)
        // A retry of the same message reuses its id, so the hub can drop a duplicate of a lost response.
        const key = JSON.stringify([text, reply?.id])
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        setSending(true)
        try {
            if (await onSend({ text, mentions, replyTo: reply?.id, clientMessageId: attempt.current.id })) {
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
                .filter(member => member.kind !== 'user'
                    && `${memberName(member)} ${member.id}`.toLowerCase().includes(needle))
                .map(member => ({
                    key: member.id,
                    text: `@${member.id}`,
                    label: memberName(member),
                    icon: <ThreadAvatar id={member.id} kind={member.kind === 'session' ? 'session' : 'guest'} />,
                    description: member.mentionWake ? member.status : `${member.status} · muted`
                }))
        }
    }), [members])

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <ChatComposer
                ref={ref}
                items={['quickPhrases']}
                disabled={sending}
                placeholder="Message the thread · @ to mention"
                ariaLabel="Message"
                api={api}
                suggestions={suggestions}
                inputHeader={reply ? <ReplyHeader reply={reply} members={members} disabled={sending} onCancel={onCancelReply} /> : null}
            />
        </AssistantRuntimeProvider>
    )
})

function ReplyHeader({ reply, members, disabled, onCancel }: { reply: ThreadMessage; members: Member[]; disabled: boolean; onCancel: () => void }) {
    const text = useAssistantState(({ composer }) => composer.text)
    const sender = reply.sender
    const replyMember = sender.kind === 'session' ? members.find(member => member.id === sender.sessionId) : undefined
    return (
        <div className="flex items-center gap-2 border-l-2 border-[var(--app-link)] mx-4 mt-3 px-2 text-sm">
            <div className="min-w-0 flex-1">
                <span className="text-[var(--app-hint)]">Replying to #{reply.seq}</span>
                <p className="truncate">{mentionText(reply.text, id => {
                    const member = members.find(candidate => candidate.id === id)
                    return member ? memberName(member) : id.slice(0, 8)
                })}</p>
                {replyMember && !mentionedIds(text, members).length ? (
                    <p className="text-xs text-[var(--app-link)]">
                        Notifies @{memberName(replyMember)}
                        {!replyMember.mentionWake ? ' (muted)' : replyMember.status === 'inactive' ? ' (inactive)' : ''}
                    </p>
                ) : null}
            </div>
            <button type="button" className={threadButton} aria-label="Cancel reply" onClick={onCancel} disabled={disabled}>✕</button>
        </div>
    )
}
