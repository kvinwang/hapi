import { QuickPhrasesPanel } from '@/components/AssistantChat/QuickPhrasesPanel'
import { StarIcon } from '@/components/icons'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import type { QuickPhraseAction } from '@/types/api'
import { useEffect, useRef, useState } from 'react'
import type { ThreadMessage } from '@hapi/protocol/threads'
import { threadButton, memberName, type Member } from './types'

export function ThreadComposer({
    members,
    reply,
    onCancelReply,
    onSend
}: {
    members: Member[]
    reply?: ThreadMessage
    onCancelReply: () => void
    onSend: (input: { text: string; mentions: string[]; replyTo?: string; clientMessageId: string }) => Promise<boolean>
}) {
    const { api, guest } = useAppContext()
    const { t } = useTranslation()
    const [showQuickPhrases, setShowQuickPhrases] = useState(false)
    const quickPhrasesRoot = useRef<HTMLDivElement>(null)
    const quickPhrasesButton = useRef<HTMLButtonElement>(null)
    const replySessionId = reply?.sender.kind === 'session' ? reply.sender.sessionId : undefined
    const replyMember = members.find(member => member.id === replySessionId)
    const [text, setText] = useState('')
    const [mentions, setMentions] = useState<string[]>([])
    const [cursor, setCursor] = useState(0)
    const [picking, setPicking] = useState(false)
    const [active, setActive] = useState(0)
    const [sending, setSending] = useState(false)
    const textarea = useRef<HTMLTextAreaElement>(null)
    const inFlight = useRef(false)
    const attempt = useRef<{ key: string; id: string } | null>(null)
    const query = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))
    const candidates = members.filter(
        member =>
            member.kind === 'session' &&
            !mentions.includes(member.id) &&
            (!query || `${memberName(member)} ${member.id}`.toLowerCase().includes(query[1].toLowerCase()))
    )
    const selected = candidates[Math.min(active, Math.max(0, candidates.length - 1))]
    useEffect(() => {
        const el = textarea.current
        if (el) {
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`
        }
    }, [text])
    useEffect(() => {
        if (reply) textarea.current?.focus()
    }, [reply])
    useEffect(() => {
        if (!showQuickPhrases) return
        const close = (event: PointerEvent) => {
            if (
                !quickPhrasesRoot.current?.contains(event.target as Node) &&
                !quickPhrasesButton.current?.contains(event.target as Node)
            )
                setShowQuickPhrases(false)
        }
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setShowQuickPhrases(false)
                quickPhrasesButton.current?.focus()
            }
        }
        document.addEventListener('pointerdown', close)
        document.addEventListener('keydown', escape)
        return () => {
            document.removeEventListener('pointerdown', close)
            document.removeEventListener('keydown', escape)
        }
    }, [showQuickPhrases])
    const choose = (member: Member) => {
        setMentions(previous => [...previous, member.id])
        if (query) {
            const start = cursor - query[1].length - 1
            setText(text.slice(0, start) + text.slice(cursor))
            setCursor(start)
        }
        setPicking(false)
        textarea.current?.focus()
    }
    const validMentions = mentions.filter(id => members.some(member => member.id === id))
    const canSend = Boolean(text.trim() || validMentions.length)
    const submit = async (phrase?: string) => {
        const message = phrase ?? text
        if (inFlight.current || (!message.trim() && !validMentions.length)) return
        inFlight.current = true
        setSending(true)
        const key = JSON.stringify([message, validMentions, reply?.id])
        if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() }
        try {
            if (
                await onSend({
                    text: message,
                    mentions: validMentions,
                    replyTo: reply?.id,
                    clientMessageId: attempt.current.id
                })
            ) {
                if (phrase === undefined) setText('')
                setMentions([])
                setPicking(false)
                onCancelReply()
                attempt.current = null
            } else if (phrase !== undefined && !text) {
                setText(phrase)
            }
        } finally {
            inFlight.current = false
            setSending(false)
        }
    }
    const pickPhrase = (phrase: string, action: QuickPhraseAction) => {
        setShowQuickPhrases(false)
        setPicking(false)
        if (action === 'send') {
            void submit(phrase)
            return
        }
        const el = textarea.current
        const start = el?.selectionStart ?? text.length
        const end = el?.selectionEnd ?? text.length
        setText(text.slice(0, start) + phrase + text.slice(end))
        const position = start + phrase.length
        setCursor(position)
        requestAnimationFrame(() => {
            textarea.current?.focus()
            textarea.current?.setSelectionRange(position, position)
        })
    }
    return (
        <form
            className="relative mx-auto w-full max-w-4xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            onSubmit={e => {
                e.preventDefault()
                void submit()
            }}
        >
            {showQuickPhrases && !guest && (
                <div
                    ref={quickPhrasesRoot}
                    role="region"
                    aria-label={t('settings.nav.quickPhrases')}
                    className="absolute bottom-full left-3 right-3 z-10 max-h-72 overflow-y-auto rounded-xl border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] shadow-lg"
                >
                    <QuickPhrasesPanel api={api} onPick={pickPhrase} />
                </div>
            )}
            {picking && (
                <div
                    id="thread-mention-options"
                    role="listbox"
                    aria-label="Mention a member"
                    className="absolute bottom-full left-3 right-3 max-h-60 overflow-y-auto rounded-xl border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] p-2 shadow-lg"
                >
                    {candidates.length ? (
                        candidates.map(member => (
                            <button
                                key={member.id}
                                id={`mention-${member.id}`}
                                type="button"
                                role="option"
                                aria-selected={selected?.id === member.id}
                                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left ${selected?.id === member.id ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                                onMouseDown={e => e.preventDefault()}
                                onClick={() => choose(member)}
                            >
                                <span className="truncate">{memberName(member)}</span>
                                <span className="ml-2 text-xs text-[var(--app-hint)]">
                                    {member.status}
                                    {!member.mentionWake && ' · muted'}
                                </span>
                            </button>
                        ))
                    ) : (
                        <p className="p-3 text-sm text-[var(--app-hint)]">No matching members</p>
                    )}
                </div>
            )}
            <div className="rounded-2xl border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] p-2 shadow-sm">
                {reply && (
                    <div className="mb-2 flex items-center gap-2 border-l-2 border-[var(--app-link)] px-2 text-sm">
                        <div className="min-w-0 flex-1">
                            <span className="text-[var(--app-hint)]">Replying to #{reply.seq}</span>
                            <p className="truncate">{reply.text}</p>
                            {replyMember && (
                                <p className="text-xs text-[var(--app-link)]">
                                    Notifies @{memberName(replyMember)}
                                    {!replyMember.mentionWake
                                        ? ' (muted)'
                                        : replyMember.status === 'inactive'
                                          ? ' (inactive)'
                                          : ''}
                                </p>
                            )}
                        </div>
                        <button
                            type="button"
                            className={threadButton}
                            aria-label="Cancel reply"
                            onClick={onCancelReply}
                            disabled={sending}
                        >
                            ✕
                        </button>
                    </div>
                )}
                {!!mentions.length && (
                    <div className="mb-1 flex flex-wrap gap-1">
                        {mentions.map(id => (
                            <button
                                type="button"
                                key={id}
                                className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-link)]"
                                disabled={sending}
                                onClick={() => setMentions(previous => previous.filter(value => value !== id))}
                                aria-label={`Remove mention ${members.find(member => member.id === id)?.title ?? id}`}
                            >
                                @{members.find(member => member.id === id)?.title ?? id.slice(0, 8)} ×
                            </button>
                        ))}
                    </div>
                )}
                <textarea
                    ref={textarea}
                    aria-label="Message"
                    aria-controls={picking ? 'thread-mention-options' : undefined}
                    aria-activedescendant={picking && selected ? `mention-${selected.id}` : undefined}
                    placeholder="Message the thread · @ to mention"
                    rows={2}
                    maxLength={32000}
                    className="block max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1 outline-none"
                    value={text}
                    disabled={sending}
                    onChange={e => {
                        const value = e.target.value
                        const position = e.target.selectionStart
                        setText(value)
                        setCursor(position)
                        setActive(0)
                        setPicking(/(?:^|\s)@[^\s@]*$/.test(value.slice(0, position)))
                        setShowQuickPhrases(false)
                    }}
                    onClick={e => {
                        const position = e.currentTarget.selectionStart
                        setCursor(position)
                        setPicking(/(?:^|\s)@[^\s@]*$/.test(text.slice(0, position)))
                    }}
                    onKeyDown={e => {
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return
                        if (picking && e.key === 'Escape') {
                            e.preventDefault()
                            setPicking(false)
                            return
                        }
                        if (picking && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
                            e.preventDefault()
                            setActive(
                                value =>
                                    (value + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) %
                                    Math.max(1, candidates.length)
                            )
                            return
                        }
                        if (picking && e.key === 'Enter') {
                            e.preventDefault()
                            if (selected) choose(selected)
                            return
                        }
                        if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia('(pointer: coarse)').matches) {
                            e.preventDefault()
                            void submit()
                        }
                    }}
                />
                <div className="flex items-center justify-between gap-2">
                    <button
                        type="button"
                        className={`${threadButton} text-lg`}
                        aria-label="Mention a member"
                        aria-expanded={picking}
                        disabled={sending}
                        onClick={() => {
                            setShowQuickPhrases(false)
                            setPicking(value => !value)
                            setCursor(textarea.current?.selectionStart ?? text.length)
                            setActive(0)
                        }}
                    >
                        @
                    </button>
                    {!guest && <button
                        ref={quickPhrasesButton}
                        type="button"
                        className={threadButton}
                        title={t('settings.nav.quickPhrases')}
                        aria-label={t('settings.nav.quickPhrases')}
                        aria-expanded={showQuickPhrases}
                        disabled={sending}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => {
                            setPicking(false)
                            setShowQuickPhrases(value => !value)
                        }}
                    >
                        <StarIcon width={18} height={18} />
                    </button>}
                    <span className="flex-1 text-xs text-[var(--app-hint)]">Mentions request action</span>
                    <button
                        type="submit"
                        className="rounded-full bg-[var(--app-link)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                        disabled={sending || !canSend}
                    >
                        {sending ? 'Sending…' : 'Send'}
                    </button>
                </div>
            </div>
        </form>
    )
}
